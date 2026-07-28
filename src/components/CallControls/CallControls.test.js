import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CallControls } from './CallControls';

function mount(callState) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CallControls
        callState={callState}
        onCall={() => {}}
        onHangup={() => {}}
        onMute={() => {}}
        hasNumber
      />
    );
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CallControls Voice SDK states', () => {
  it('enables active controls for the SDK open state', () => {
    const { container, root } = mount('open');

    expect(container.querySelector('.call-controls').className).toContain('active');
    expect(container.querySelector('.mute').disabled).toBe(false);

    act(() => root.unmount());
  });

  it('keeps mute disabled while ringing but allows hangup', () => {
    const { container, root } = mount('ringing');

    expect(container.querySelector('.call-controls').className).toContain('active');
    expect(container.querySelector('.mute').disabled).toBe(true);
    expect(container.querySelector('.hangup')).not.toBeNull();

    act(() => root.unmount());
  });
});
