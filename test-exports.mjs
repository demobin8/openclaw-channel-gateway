import pkg from './node_modules/openclaw/package.json' with { type: 'json' };
const exports = pkg.exports;
const keys = Object.keys(exports);
// Filter to plugin-sdk related exports
const sdkExports = keys.filter(k => k.startsWith('./plugin-sdk/'));
console.log('plugin-sdk exports:', sdkExports.join('\n'));
