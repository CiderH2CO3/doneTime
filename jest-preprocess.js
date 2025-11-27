const fs = require('fs');

module.exports = {
  process(src, filename, config, options) {
    // Only transform the target file, app.js
    if (filename.endsWith('js/app.js')) {
      // List the names of the functions you want to test and export.
      const functionsToExport = [
        'msToHMS',
        'escapeHtml',
        'linkifyTask',
        'loadSettings',
      ];

      // Append the module.exports line to the end of the file content.
      const exportsString = `\n;module.exports = { ${functionsToExport.filter(name => src.includes(name)).join(', ')} };`;

      return { code: src + exportsString };
    }

    // For all other files, return the code unmodified.
    return { code: src };
  },
};
