import { $createElement } from '../../utils';

class DistortionImage {
  /**
   * Canvas element reference for rendering distortion effects.
   * @type {HTMLCanvasElement|null}
   */
  #canvas = null;
  #lifetime = new AbortController();
  #frame = 0;
  #buffer = null;

  constructor(image) {
    this.#canvas = $createElement('canvas');
    this.gl = this.canvas.getContext('webgl');

    if (!this.gl) {
      throw new Error('WebGL not supported');
    }

    this.program = null;
    this.attribs = {};
    this.uniforms = {};
    this.texture = null;
    this.startTime = performance.now();

    try {
      this.init(image);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  get canvas() {
    return this.#canvas;
  }

  init(image) {
    const gl = this.gl;

    // Load shader program
    this.program = this.createProgram(
      this.vertexShaderSource(),
      this.fragmentShaderSource()
    );
    gl.useProgram(this.program);

    // Lookups
    this.getLocations();

    // Full-screen quad
    this.initQuad();

    this.loadTexture(image);

    this.resize();
    const { signal } = this.#lifetime;
    window.addEventListener('resize', () => this.resize(), { signal });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stopFrame();
      else this.queueFrame();
    }, { signal });
    this.queueFrame();
  }

  queueFrame() {
    if (this.#frame || document.hidden || this.#lifetime.signal.aborted) return;
    this.#frame = requestAnimationFrame(time => {
      this.#frame = 0;
      this.draw(time);
    });
  }

  stopFrame() {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  destroy() {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort();
    this.stopFrame();
    const gl = this.gl;
    if (this.#buffer) gl.deleteBuffer(this.#buffer);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.program) gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  vertexShaderSource() {
    return `
      attribute vec2 a_position;
      varying vec2 v_uv;

      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }`;
  }

  fragmentShaderSource() {
    return `
      precision mediump float;

      uniform sampler2D u_texture;
      uniform vec2 u_resolution;
      uniform vec2 u_imageSize;
      uniform float u_time;

      varying vec2 v_uv;

      vec2 uvCover(vec2 uv) {
        float rImg = u_imageSize.x / u_imageSize.y;
        float rScr = u_resolution.x / u_resolution.y;

        vec2 scale = vec2(1.0);
        if (rScr > rImg) {
            scale.y = rImg / rScr;
        } else {
            scale.x = rScr / rImg;
        }

        uv = (uv - 0.5) * scale + 0.5;
        uv.y = 1.0 - uv.y;
        return uv;
      }

      float hash(vec2 p) {
        p = fract(p * 0.3183099 + vec2(0.71, 0.113));
        return fract(23.0 * dot(p, p));
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);

        return mix(a, b, u.x)
          + (c - a) * u.y * (1.0 - u.x)
          + (d - b) * u.y * u.x;
      }

      float NOISE_SCALE_1 = 10.0;
      float NOISE_SCALE_2 = 20.0;
      float MAX_STRENGTH = 0.03;
      float FALLOFF = 3.0;

      void main() {
        vec2 uv = uvCover(v_uv);

        vec2 center = vec2(0.5);
        vec2 delta = uv - center;
        float dist = length(delta);

        float strength = MAX_STRENGTH * exp(-dist * FALLOFF);

        float n1 = noise(uv * NOISE_SCALE_1 + u_time * 0.5);
        float n2 = noise(uv * NOISE_SCALE_2 + u_time * 1.2);
        float n = n1 * 0.6 + n2 * 0.4;

        uv += delta * strength * n;

        uv = clamp(uv, vec2(0.0), vec2(1.0));

        gl_FragColor = texture2D(u_texture, uv);
      }`;
  }

  // program + shaders
  createShader(type, src) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  createProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = this.createShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.createShader(gl.FRAGMENT_SHADER, fsSrc);
    let program;
    try {
      if (!vs || !fs) throw new Error('Could not compile background shaders');
      program = gl.createProgram();
      if (!program) throw new Error('Could not allocate background shader program');
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Could not link background shaders');
      }
      gl.detachShader(program, vs);
      gl.detachShader(program, fs);
      return program;
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
    }
  }

  initQuad() {
    const gl = this.gl;

    const data = new Float32Array([
      -1, -1,
      1, -1,
      -1,  1,
      -1,  1,
      1, -1,
      1,  1
    ]);

    this.#buffer = gl.createBuffer();
    if (!this.#buffer) throw new Error('Could not allocate background geometry');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(this.attribs.a_position);
    gl.vertexAttribPointer(this.attribs.a_position, 2, gl.FLOAT, false, 0, 0);
  }

  getLocations() {
    const gl = this.gl;
    const p = this.program;

    this.attribs.a_position = gl.getAttribLocation(p, 'a_position');

    this.uniforms.u_time = gl.getUniformLocation(p, 'u_time');
    this.uniforms.u_resolution = gl.getUniformLocation(p, 'u_resolution');
    this.uniforms.u_imageSize = gl.getUniformLocation(p, 'u_imageSize');
    this.uniforms.u_texture = gl.getUniformLocation(p, 'u_texture');
  }

  loadTexture(img) {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Could not allocate background texture');
    this.texture = tex;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.uniform1i(this.uniforms.u_texture, 0);
    gl.uniform2f(this.uniforms.u_imageSize, img.naturalWidth, img.naturalHeight);
  }

  resize() {
    const gl = this.gl;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.#canvas.width = Math.round(w * dpr);
    this.#canvas.height = Math.round(h * dpr);

    this.#canvas.style.width = w + 'px';
    this.#canvas.style.height = h + 'px';

    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    gl.uniform2f(this.uniforms.u_resolution, this.#canvas.width, this.#canvas.height);
  }

  draw(t) {
    const gl = this.gl;
    if (this.#lifetime.signal.aborted || document.hidden || gl.isContextLost()) return;

    // wrap time every few minutes
    let time = (t - this.startTime) * 0.001;
    if (time > 600) {
      this.startTime = t;
      time = 0;
    }

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform1f(this.uniforms.u_time, time);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.queueFrame();
  }
}

export default DistortionImage;
