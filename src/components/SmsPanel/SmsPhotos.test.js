// Accepted TWP-9 piece 4 (docs/phone-ux-plan.md), the composer and thread side:
// attachment drafts that survive a restart, previews with individual removal,
// notices before Send, truthful failed/unknown outcomes for photo messages,
// and incoming photos shown, pending, or as placeholders. The service behind
// these calls (limits, countries, links, downloads) is covered by
// src/serverPhotos.test.js; here the context is a stand-in with the same shape.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceProvider } from '../../workspace/WorkspaceContext';
import { SmsPanel } from './SmsPanel';
import { SmsContext } from '../../contexts/SmsContext';
import { JPEG, PNG } from '../../photoFixtures';

const NUMBER = '+12025550101';
const MiB = 1024 * 1024;
const hex = (n) => String(n).padStart(32, '0');

const photoMeta = (n, over = {}) => ({
  id: hex(n),
  type: 'image/jpeg',
  bytes: JPEG.length,
  width: 48,
  height: 32,
  name: `holiday-${n}.jpg`,
  ...over,
});

const policyOk = {
  ok: true,
  supported: true,
  reason: null,
  country: 'US',
  limits: { maxPhotos: 10, maxBytes: 5 * MiB, linkHours: 24 },
};

// A saved workspace as the desktop's config store would hold it.
function fakeConfig(initial = {}) {
  const store = { workspace: initial };
  window.operator = {
    config: {
      get: async (key) => store[key],
      set: async (key, value) => {
        store[key] = JSON.parse(JSON.stringify(value));
        return value;
      },
    },
  };
  return store;
}

function mount({ thread, send, policy = policyOk, attachPhoto, discardPhoto } = {}) {
  const calls = { send: [], attach: [], discard: [], prune: [] };
  const base = thread || { number: NUMBER, messages: [] };
  let current = base;
  const conversations = [
    {
      number: NUMBER,
      lastMessageAt: current.messages.at(-1)?.at || 0,
      lastBody: current.messages.at(-1)?.body || '',
      lastDirection: current.messages.at(-1)?.direction || null,
      messageCount: current.messages.length,
      messages: current.messages,
    },
  ];
  const value = {
    snapshot: { conversations, state: 'ready', lastError: null, hydrated: true },
    send:
      send ||
      (async (payload) => {
        calls.send.push(payload);
        return { ok: true, sid: 'MMsent', to: payload.to, status: 'queued', mms: Boolean(payload.media) };
      }),
    getThread: async () => current,
    clearThread: async () => current,
    refresh: async () => {},
    destroy: async () => {},
    service: { subscribe: () => () => {} },
    attachPhoto:
      attachPhoto ||
      (async (file) => {
        calls.attach.push(file.name);
        return photoMeta(100 + calls.attach.length, { name: file.name, bytes: file.size });
      }),
    photoBlob: async () => new Blob([JPEG], { type: 'image/jpeg' }),
    discardPhoto: discardPhoto || (async (id) => calls.discard.push(id)),
    prunePhotos: async (keep) => calls.prune.push(keep),
    photoPolicy: async () => policy,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root;
  act(() => {
    root = createRoot(container);
    root.render(
      <SmsContext.Provider value={value}>
        <WorkspaceProvider>
          <SmsPanel />
        </WorkspaceProvider>
      </SmsContext.Provider>,
    );
  });
  return {
    container,
    calls,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function openThread(container) {
  await settle(); // the saved workspace loads first
  const row = container.querySelector('.sms-list-item');
  if (row && row.getAttribute('aria-pressed') !== 'true') await act(async () => row.click());
  await settle();
}

async function typeText(container, text) {
  await act(async () => {
    const input = container.querySelector('.sms-composer-input');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function chooseFiles(container, files) {
  await act(async () => {
    const input = container.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

const file = (name, size = JPEG.length, type = 'image/jpeg') => {
  const f = new File([JPEG], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const sendButton = (c) => c.querySelector('.sms-composer-send');
const chips = (c) => Array.from(c.querySelectorAll('.photo-chip'));
const pressSend = async (c) => {
  await act(async () => sendButton(c).click());
  await settle();
};

beforeEach(() => {
  URL.createObjectURL = jest.fn(() => 'blob:fixture-photo');
  URL.revokeObjectURL = jest.fn();
});
afterEach(() => {
  document.body.innerHTML = '';
  delete window.operator;
});

describe('photo drafts in the composer', () => {
  it('shows a preview per attached photo, uploads nothing, and sends photo-only with Send', async () => {
    fakeConfig();
    const { container, calls, unmount } = mount();
    await openThread(container);
    // A photo-only message needs no text, but needs a photo.
    expect(sendButton(container).disabled).toBe(true);

    await chooseFiles(container, [file('a.jpg'), file('b.jpg')]);

    expect(chips(container)).toHaveLength(2);
    expect(container.querySelector('.photo-chip img')).not.toBeNull();
    expect(container.querySelector('.sms-composer-counter').textContent).toMatch(/MMS \(a picture message, not SMS segments\) · 2 photos · \d+ KB of 5\.0 MB/);
    expect(container.textContent).toMatch(/kept on this computer until you press Send/);
    expect(container.querySelector('.sms-composer-counter').textContent).not.toMatch(/\d+ SMS segments?/); // no segment count for a picture message
    expect(calls.send).toHaveLength(0); // attaching sends nothing
    expect(sendButton(container).disabled).toBe(false);

    await pressSend(container);

    expect(calls.send).toEqual([{ to: NUMBER, body: '', media: [hex(101), hex(102)] }]);
    expect(chips(container)).toHaveLength(0);
    unmount();
  });

  it('removes one photo at a time and tells the service to discard that draft', async () => {
    fakeConfig();
    const { container, calls, unmount } = mount();
    await openThread(container);
    await chooseFiles(container, [file('a.jpg'), file('b.jpg'), file('c.jpg')]);

    await act(async () => container.querySelector('button[aria-label^="Remove photo 2"]').click());

    expect(chips(container)).toHaveLength(2);
    expect(calls.discard).toEqual([hex(102)]);
    expect(container.querySelector('.sms-composer-counter').textContent).toMatch(/2 photos/);
    unmount();
  });

  it('keeps each recipient’s photos and text through a restart', async () => {
    const store = fakeConfig();
    const first = mount();
    await openThread(first.container);
    await typeText(first.container, 'Look at these');
    await chooseFiles(first.container, [file('a.jpg')]);
    first.unmount();
    // The saved workspace holds the draft: the text and the photo's description, not its bytes.
    expect(store.workspace.attachments[NUMBER]).toEqual([photoMeta(101, { name: 'a.jpg' })]);
    expect(store.workspace.drafts[NUMBER]).toBe('Look at these');

    const second = mount();
    await openThread(second.container);

    expect(chips(second.container)).toHaveLength(1);
    expect(second.container.querySelector('.sms-composer-input').value).toBe('Look at these');
    // The saved list is what the service is told to keep.
    expect(second.calls.prune).toEqual([[hex(101)]]);
    second.unmount();
  });

  it('stops at ten photos and says so', async () => {
    fakeConfig();
    const { container, calls, unmount } = mount();
    await openThread(container);

    await chooseFiles(container, Array.from({ length: 12 }, (_, i) => file(`p${i}.jpg`)));

    expect(calls.attach).toHaveLength(10);
    expect(chips(container)).toHaveLength(10);
    expect(container.textContent).toMatch(/up to 10 photos/);
    expect(container.querySelector('.attach-photos').disabled).toBe(true);
    unmount();
  });

  it('refuses a photo that would take the message to 5 MB, before adding it', async () => {
    fakeConfig();
    const { container, calls, unmount } = mount();
    await openThread(container);
    await chooseFiles(container, [file('big.jpg', 3 * MiB)]);

    await chooseFiles(container, [file('too-much.jpg', 2.5 * MiB), file('small.jpg', 100 * 1024)]);

    expect(calls.attach).toEqual(['big.jpg', 'small.jpg']);
    expect(container.textContent).toMatch(/too-much\.jpg would take the message to 5\.0 MB or more/);
    unmount();
  });

  it('shows what the service said when it cannot use a file', async () => {
    fakeConfig();
    const { container, unmount } = mount({
      attachPhoto: async () => {
        throw new Error('The file is not a JPEG or PNG photo.');
      },
    });
    await openThread(container);

    await chooseFiles(container, [file('notes.png', 40, 'image/png')]);

    expect(container.querySelector('[role="alert"]').textContent).toBe('The file is not a JPEG or PNG photo.');
    expect(chips(container)).toHaveLength(0);
    unmount();
  });
});

describe('notices before Send', () => {
  const abroad = {
    ok: true,
    supported: false,
    country: null,
    reason: { code: 'unsupported-country', message: 'Photos can be sent only to numbers in the United States and Canada. This number is somewhere else, so send text only.' },
    limits: policyOk.limits,
  };

  it('explains an unsupported destination, blocks attaching, and still sends text', async () => {
    fakeConfig();
    const { container, calls, unmount } = mount({ policy: abroad });
    await openThread(container);

    expect(container.querySelector('.photo-notice').textContent).toMatch(/United States and Canada/);
    expect(container.querySelector('.attach-photos').disabled).toBe(true);
    await typeText(container, 'text only is fine');
    await pressSend(container);

    expect(calls.send).toEqual([{ to: NUMBER, body: 'text only is fine' }]);
    unmount();
  });

  it('blocks Send for photos already in the draft when the sender cannot send them', async () => {
    fakeConfig({ attachments: { [NUMBER]: [photoMeta(1)] }, selected: NUMBER });
    const noMms = {
      ...policyOk,
      supported: false,
      reason: { code: 'sender-no-mms', message: 'Your Twilio number cannot send photos (MMS). Choose a number that can, or send text only.' },
    };
    const { container, calls, unmount } = mount({ policy: noMms });
    await openThread(container);
    await typeText(container, 'hello');

    expect(container.querySelector('.photo-notice').textContent).toMatch(/cannot send photos \(MMS\)/);
    expect(sendButton(container).disabled).toBe(true);
    expect(chips(container)).toHaveLength(1); // the draft is kept
    expect(calls.send).toHaveLength(0);
    unmount();
  });

  it('blocks Send while the public tunnel is down, and says photos wait for it', async () => {
    fakeConfig({ attachments: { [NUMBER]: [photoMeta(1)] }, selected: NUMBER });
    window.operator.session = {
      status: async () => ({ ok: true, managed: true, service: { state: 'ready' }, tunnel: { state: 'unreachable', url: null, reason: 'ngrok is not reachable' } }),
    };
    const { container, unmount } = mount();
    await openThread(container);
    await settle();

    expect(container.querySelector('.photo-notice').textContent).toMatch(/public tunnel, which is not reachable/);
    expect(sendButton(container).disabled).toBe(true);
    unmount();
  });
});

describe('photo message outcomes', () => {
  async function draftWithPhoto(number, send) {
    fakeConfig({ attachments: { [NUMBER]: [photoMeta(7)] }, selected: NUMBER });
    const view = mount({ send });
    await openThread(view.container);
    await typeText(view.container, 'Here is the picture');
    return view;
  }

  it('keeps the text and photos after a confirmed failure, so the person can retry', async () => {
    const { container, unmount } = await draftWithPhoto(NUMBER, async () => {
      const error = new Error('The destination rejected this test message.');
      error.outcome = 'failed';
      throw error;
    });

    await pressSend(container);

    expect(container.textContent).toMatch(/The destination rejected this test message\./);
    expect(chips(container)).toHaveLength(1);
    expect(container.querySelector('.sms-composer-input').value).toBe('Here is the picture');
    expect(sendButton(container).disabled).toBe(false);
    unmount();
  });

  it('after an unknown result keeps the text, moves the photos to the conversation, and blocks resending', async () => {
    const { container, unmount } = await draftWithPhoto(NUMBER, async () => {
      throw new Error('Connection closed');
    });

    await pressSend(container);

    expect(container.textContent).toMatch(/Unknown outcome: “Here is the picture” with photo/);
    expect(container.querySelector('.sms-composer-input').value).toBe('Here is the picture');
    expect(chips(container)).toHaveLength(0); // never sendable again from the draft
    expect(sendButton(container).disabled).toBe(false); // different content (no photo) may be sent
    unmount();
  });

  it('lists the photos in the review of a resend after a confirmed failure', async () => {
    fakeConfig();
    const failedPhoto = { id: hex(9), state: 'ready', type: 'image/jpeg', bytes: JPEG.length, width: 48, height: 32 };
    const thread = {
      number: NUMBER,
      messages: [
        { sid: 'MMfailed', body: 'Photo for you', at: 1781856000000, direction: 'outbound', status: 'failed', mms: true, media: [failedPhoto, { ...failedPhoto, id: hex(10) }] },
      ],
    };
    const { container, calls, unmount } = mount({ thread });
    await openThread(container);

    await act(async () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Review resend').click());
    expect(document.querySelector('dialog').textContent).toMatch(/Sends 2 photos again, as an MMS/);
    await act(async () => Array.from(document.querySelectorAll('dialog button')).find((b) => b.textContent === 'Resend message').click());
    await settle();

    expect(calls.send).toEqual([{ to: NUMBER, body: 'Photo for you', media: [hex(9), hex(10)] }]);
    unmount();
  });
});

describe('photos in the conversation', () => {
  const ready = (n) => ({ id: hex(n), state: 'ready', type: n % 2 ? 'image/jpeg' : 'image/png', bytes: PNG.length, width: 48, height: 32 });
  const thread = {
    number: NUMBER,
    messages: [
      { sid: 'MM1', body: '', at: 1781856000000, direction: 'inbound', status: 'received', media: [ready(1), ready(2), { id: hex(3), state: 'pending' }, { id: hex(4), state: 'unavailable', reason: 'unsupported-type', contentType: 'image/gif' }, { id: hex(5), state: 'unavailable', reason: 'too-large' }] },
      { sid: 'MM2', body: 'Got them', at: 1781856060000, direction: 'outbound', status: 'delivered', mms: true, media: [ready(6)] },
      { sid: 'SM3', body: 'Plain text', at: 1781856120000, direction: 'outbound', status: 'delivered' },
    ],
  };

  it('shows photos, a pending placeholder and a placeholder for each kind of unavailable photo', async () => {
    fakeConfig();
    const { container, unmount } = mount({ thread });
    await openThread(container);

    const bubbles = Array.from(container.querySelectorAll('.sms-bubble'));
    expect(bubbles[0].querySelectorAll('.sms-photo img')).toHaveLength(2);
    expect(bubbles[0].textContent).toMatch(/Photo downloading…/);
    expect(bubbles[0].textContent).toMatch(/A GIF attachment arrived, but Operator shows only JPEG and PNG photos\./);
    expect(bubbles[0].textContent).toMatch(/too large to download/);
    expect(bubbles[0].querySelector('.sms-bubble-body')).toBeNull(); // no empty text bubble for a photo-only message
    // Photo messages are labelled MMS; a text is not.
    expect(bubbles[0].querySelector('.sms-mms')).not.toBeNull();
    expect(bubbles[1].querySelector('.sms-mms')).not.toBeNull();
    expect(bubbles[2].querySelector('.sms-mms')).toBeNull();
    // The conversation row says what the last message holds.
    unmount();
  });

  it('opens a larger local view with Previous and Next, and closes it', async () => {
    fakeConfig();
    const { container, unmount } = mount({ thread });
    await openThread(container);

    await act(async () => container.querySelector('button[aria-label^="Open photo 1 of 2"]').click());
    await settle();
    const dialog = () => document.querySelector('dialog.photo-viewer');
    expect(dialog().textContent).toMatch(/Photo 1 of 2 · 48×32/);
    expect(Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent === 'Previous').disabled).toBe(true);

    await act(async () => Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent === 'Next').click());
    await settle();
    expect(dialog().textContent).toMatch(/Photo 2 of 2/);

    await act(async () => Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent === 'Close').click());
    expect(dialog()).toBeNull();
    unmount();
  });

  it('summarizes a photo-only message in the conversation list', async () => {
    fakeConfig();
    const photoOnly = { number: NUMBER, messages: [thread.messages[0]] };
    const { container, unmount } = mount({ thread: photoOnly });
    await settle();

    expect(container.querySelector('.sms-list-preview').textContent).toBe('5 photos');
    unmount();
  });
});
