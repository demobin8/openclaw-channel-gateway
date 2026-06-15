// Test importing OpenClaw's createRuntimeChannel
import { t as createRuntimeChannel } from 'openclaw/dist/runtime-channel-Cip35nX1.js';

try {
  const ch = createRuntimeChannel();
  console.log('channel created:', Object.keys(ch));
  console.log('reply ops:', Object.keys(ch.reply));
  console.log('commands ops:', Object.keys(ch.commands));
  console.log('routing ops:', Object.keys(ch.routing));
  console.log('session ops:', Object.keys(ch.session));
  console.log('media ops:', Object.keys(ch.media));
  console.log('SUCCESS');
} catch (err) {
  console.error('FAILED:', err.message);
  console.error(err.stack);
}
