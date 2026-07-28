const previousCallerId = process.env.TWILIO_CALLER_ID;
const previousOperatorIdentity = process.env.OPERATOR_IDENTITY;
process.env.TWILIO_CALLER_ID = '+15551234567';
process.env.OPERATOR_IDENTITY = 'operator';

const { renderTwiml } = require('../server/server');

afterAll(() => {
  if (previousCallerId === undefined) delete process.env.TWILIO_CALLER_ID;
  else process.env.TWILIO_CALLER_ID = previousCallerId;
  if (previousOperatorIdentity === undefined) delete process.env.OPERATOR_IDENTITY;
  else process.env.OPERATOR_IDENTITY = previousOperatorIdentity;
});

function render(params) {
  const response = {
    writeHead: jest.fn(),
    end: jest.fn(),
  };
  renderTwiml(params, response);
  return response.end.mock.calls[0][0];
}

describe('outbound voice TwiML', () => {
  it('preserves ringing for PSTN destinations', () => {
    const xml = render({ From: 'client:operator', To: '+15558675309' });

    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain('<Number>+15558675309</Number>');
  });

  it('preserves ringing for client destinations', () => {
    const xml = render({ From: 'client:operator', To: 'another_operator' });

    expect(xml).toContain('answerOnBridge="true"');
    expect(xml).toContain('<Client>another_operator</Client>');
  });

  it('does not change the inbound client Dial policy', () => {
    const xml = render({ From: '+15558675309', To: '+15551234567' });

    expect(xml).toContain('<Client>operator</Client>');
    expect(xml).not.toContain('answerOnBridge');
  });
});
