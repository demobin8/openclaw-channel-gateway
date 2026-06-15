// Test importing specific plugin-sdk modules
async function test(name, path) {
  try {
    const mod = await import(path);
    const keys = Object.keys(mod).filter(k => k !== 'default');
    console.log(`${name}: [${keys.join(', ')}]`);
  } catch (err) {
    console.log(`${name}: ERROR: ${err.message}`);
  }
}

await test('command-auth', 'openclaw/plugin-sdk/command-auth');
await test('command-gating', 'openclaw/plugin-sdk/command-gating');
await test('command-detection', 'openclaw/plugin-sdk/command-detection');
await test('routing', 'openclaw/plugin-sdk/routing');
await test('reply-dispatch-runtime', 'openclaw/plugin-sdk/reply-dispatch-runtime');
await test('reply-runtime', 'openclaw/plugin-sdk/reply-runtime');
await test('channel-runtime', 'openclaw/plugin-sdk/channel-runtime');
await test('session-store-runtime', 'openclaw/plugin-sdk/session-store-runtime');
await test('session-binding-runtime', 'openclaw/plugin-sdk/session-binding-runtime');
await test('media-runtime', 'openclaw/plugin-sdk/media-runtime');
await test('media-store', 'openclaw/plugin-sdk/media-store');
await test('channel-inbound', 'openclaw/plugin-sdk/channel-inbound');
await test('channel-message', 'openclaw/plugin-sdk/channel-message');
await test('channel-reply-pipeline', 'openclaw/plugin-sdk/channel-reply-pipeline');
await test('channel-reply-options-runtime', 'openclaw/plugin-sdk/channel-reply-options-runtime');
await test('channel-ingress-runtime', 'openclaw/plugin-sdk/channel-ingress-runtime');
await test('reply-payload', 'openclaw/plugin-sdk/reply-payload');
await test('reply-dedupe', 'openclaw/plugin-sdk/reply-dedupe');
await test('reply-chunking', 'openclaw/plugin-sdk/reply-chunking');
await test('reply-reference', 'openclaw/plugin-sdk/reply-reference');
