// TWP-9 piece 4: photos in the composer and in message bubbles. Everything here
// reads photos from the local service through `load(id)` (a Blob); nothing
// opens an address on the internet.
import React, { useEffect, useRef, useState } from 'react';
import { formatSize } from '../../workspace/model';

// A blob: address for a photo, released when the photo leaves the screen.
export function usePhotoUrl(id, load) {
  const [state, setState] = useState({ id: null, url: null, failed: false });
  useEffect(() => {
    let cancelled = false;
    let created = null;
    if (typeof load !== 'function' || typeof URL.createObjectURL !== 'function') {
      setState({ id, url: null, failed: true });
      return undefined;
    }
    load(id).then(
      (blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setState({ id, url: created, failed: false });
      },
      () => {
        if (!cancelled) setState({ id, url: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [id, load]);
  return state.id === id ? state : { id, url: null, failed: false };
}

function Photo({ id, load, alt, className }) {
  const { url, failed } = usePhotoUrl(id, load);
  if (failed) return <span className="photo-missing small">Photo missing</span>;
  if (!url) return <span className="photo-loading small muted">Loading photo…</span>;
  return <img className={className} src={url} alt={alt} />;
}

// The photos attached to the draft, each removable on its own.
export function DraftPhotos({ photos, load, onRemove, disabled }) {
  if (!photos.length) return null;
  return (
    <ul className="photo-strip" aria-label="Photos to send">
      {photos.map((p, i) => (
        <li key={p.id} className="photo-chip">
          <Photo
            id={p.id}
            load={load}
            className="photo-chip-image"
            alt={`Photo ${i + 1} of ${photos.length}: ${p.name || 'photo'}`}
          />
          <span className="photo-chip-size small">{formatSize(p.bytes)}</span>
          <button
            type="button"
            className="photo-remove"
            aria-label={`Remove photo ${i + 1}: ${p.name || 'photo'}`}
            disabled={disabled}
            onClick={() => onRemove(p)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

const TYPE_NAMES = {
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
  'image/tiff': 'TIFF',
  'image/bmp': 'BMP',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  'video/quicktime': 'video',
  'audio/amr': 'audio',
  'application/pdf': 'PDF',
  'text/x-vcard': 'contact card',
};

export function unavailableText(entry) {
  switch (entry.reason) {
    case 'unsupported-type': {
      const name = TYPE_NAMES[entry.contentType] || (entry.contentType ? entry.contentType : 'file');
      return `A ${name} attachment arrived, but Operator shows only JPEG and PNG photos.`;
    }
    case 'too-large':
      return 'This photo was too large to download. Messages carry under 5 MB.';
    case 'invalid':
      return 'This photo could not be read as a JPEG or PNG, so it was not kept.';
    case 'refused':
      return 'This photo came from an address Operator does not download from, so it was not fetched.';
    case 'interrupted':
      return 'This photo was still downloading when Operator stopped.';
    case 'too-many':
      return 'More photos arrived than Operator downloads (10 per message).';
    default:
      return 'This photo could not be downloaded.';
  }
}

// The photos of one message: shown, still downloading, or a placeholder saying why not.
export function MessagePhotos({ media, load, onOpen, who }) {
  const ready = media.filter((m) => m.state === 'ready');
  return (
    <div className="sms-photos">
      {media.map((m) => {
        if (m.state === 'ready') {
          const n = ready.indexOf(m) + 1;
          return (
            <button
              type="button"
              key={m.id}
              className="sms-photo"
              aria-label={`Open photo ${n} of ${ready.length} ${who}`}
              onClick={() => onOpen(ready, n - 1)}
            >
              <Photo id={m.id} load={load} className="sms-photo-image" alt={`Photo ${n} of ${ready.length} ${who}`} />
            </button>
          );
        }
        if (m.state === 'pending') {
          return (
            <p key={m.id} className="sms-photo-placeholder small" role="status">
              Photo downloading…
            </p>
          );
        }
        return (
          <p key={m.id} className="sms-photo-placeholder small">
            {unavailableText(m)}
          </p>
        );
      })}
    </div>
  );
}

// A larger view of one message's photos, with Previous/Next, on this computer only.
export function PhotoViewer({ photos, index, load, who, onIndex, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      if (dialog.close) dialog.close();
      previous?.focus?.();
    };
  }, []);
  const photo = photos[index];
  if (!photo) return null;
  return (
    <dialog
      ref={ref}
      className="photo-viewer"
      aria-label={`Photo ${index + 1} of ${photos.length} ${who}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' && index < photos.length - 1) onIndex(index + 1);
        if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      }}
    >
      <div className="photo-viewer-stage">
        <Photo id={photo.id} load={load} className="photo-viewer-image" alt={`Photo ${index + 1} of ${photos.length} ${who}`} />
      </div>
      <p className="small muted photo-viewer-caption">
        Photo {index + 1} of {photos.length} · {photo.width}×{photo.height} · {formatSize(photo.bytes)}
      </p>
      <div className="button-row">
        <button type="button" disabled={index === 0} onClick={() => onIndex(index - 1)}>
          Previous
        </button>
        <button type="button" disabled={index === photos.length - 1} onClick={() => onIndex(index + 1)}>
          Next
        </button>
        <button type="button" className="primary" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
    </dialog>
  );
}
