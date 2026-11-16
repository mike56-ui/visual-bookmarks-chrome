"""Validate and package the production build, with manifest.json at ZIP root."""
import hashlib
import json
import re
import zipfile
from pathlib import Path


def package():
    root = Path(__file__).resolve().parents[1]
    build = root / 'extension_chrome'
    manifest = json.loads((build / 'manifest.json').read_text(encoding='utf-8'))
    version = manifest['version']
    if (not re.fullmatch(r'(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}', version)
            or any(int(part) > 65535 for part in version.split('.'))):
        raise ValueError(f'Invalid extension version: {version}')
    if manifest['manifest_version'] != 3:
        raise ValueError('Expected Manifest V3')
    required = [
        manifest['background']['service_worker'],
        manifest['chrome_url_overrides']['newtab'],
        manifest['options_ui']['page'],
        *manifest['icons'].values(),
        f"_locales/{manifest['default_locale']}/messages.json",
        'js/newtab.js', 'js/options.js', 'css/newtab.css', 'css/options.css',
    ]
    for filename in required:
        if not (build / filename).is_file():
            raise ValueError(f'Missing extension file: {filename}')
    output = root / 'dist'
    output.mkdir(exist_ok=True)
    archive = output / 'visual-bookmarks-edge.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package_zip:
        for file in sorted(build.rglob('*')):
            if file.is_file():
                package_zip.write(file, file.relative_to(build).as_posix())
    with zipfile.ZipFile(archive) as package_zip:
        if package_zip.testzip() is not None:
            raise ValueError('ZIP integrity check failed')
        assert 'manifest.json' in package_zip.namelist()
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / 'SHA256SUMS.txt').write_text(f'{checksum}  {archive.name}\n', encoding='utf-8')
    print(f'Packaged {version}: {archive}')


if __name__ == '__main__':
    package()
