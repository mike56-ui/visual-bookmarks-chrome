const hiddenInDrawer = new Set([
  'show_settings_icon', 'show_back_column', 'show_create_column',
  'folder_preview', 'thumbnails_update_button', 'bookmarks_sorting_type'
]);

const message = key => browser.i18n.getMessage(key);

function drawerOption(option) {
  switch (option.id) {
    case 'dial_columns':
      return { ...option, options: option.options.map(value => value.value === 7
        ? { ...value, title: message('settings_automatic') }
        : value) };
    case 'thumbnails_update_delay':
      return { ...option, note: message('settings_manual_preview_delay') };
    case 'thumbnails_update_recursive':
      return { ...option, title: message('settings_manual_preview_nested'), note: '' };
    case 'drag_and_drop':
      return { ...option, data: undefined };
    case 'sort_by':
      return {
        ...option,
        data: undefined,
        note: '',
        options: option.options.map(value => value.value === ''
          ? { ...value, title: message('settings_frequent_first') }
          : value)
      };
    default:
      return option;
  }
}

export default function drawerSettings(sections) {
  const filterOptions = list => list.filter(option => !hiddenInDrawer.has(option.id)).map(drawerOption);
  return sections.map((section, index) => {
    const list = section.list.flatMap(item => {
      if (!item.group) return filterOptions([item]);
      const group = filterOptions(item.group);
      return group.length ? [{ ...item, group }] : [];
    });
    if (index === 1) list.splice(2, 0, {
      id: 'visit_preview_preference',
      title: message('settings_visit_preview'),
      note: message('settings_visit_permission'),
      type: 'switch'
    });
    return { ...section, list };
  });
}
