import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CallScreen } from './CallScreen';

function mount(status) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CallScreen
        call={{
          status,
          direction: 'outgoing',
          to: '+15558675309',
          startedAt: Date.now(),
        }}
        onHangup={() => {}}
        onMute={() => {}}
        onSendDigit={() => {}}
      />
    );
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CallScreen Voice SDK states', () => {
  it('shows ringing without connected-call controls', () => {
    const { container, root } = mount('ringing');

    expect(container.querySelector('.status').textContent).toContain('Ringing');
    expect(container.querySelector('.dtmf')).toBeNull();
    expect(container.querySelector('.mute')).toBeNull();
    expect(container.querySelector('.hangup')).not.toBeNull();

    act(() => root.unmount());
  });

  it('treats the SDK open state as connected', () => {
    const { container, root } = mount('open');

    expect(container.querySelector('.status').textContent).toContain('Connected');
    expect(container.querySelector('.dtmf')).not.toBeNull();
    expect(container.querySelector('.mute')).not.toBeNull();

    act(() => root.unmount());
  });
});
