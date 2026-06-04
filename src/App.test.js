// Minimal smoke test for the softphone. The full UI requires a running
// Twilio Device (which needs a real capability token + WebRTC), so we
// only assert the module loads without throwing.
import App from './App';

it('module exports the App component', () => {
  expect(App).toBeDefined();
  expect(typeof App).toBe('function');
});
