import React from 'react';

const KEYS = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

export function Dialpad({ value, onChange, onKeyPress, disabled }) {
  function press(d) {
    onChange((value || '') + d);
    if (onKeyPress) onKeyPress(d);
  }

  function backspace() {
    onChange((value || '').slice(0, -1));
  }

  return (
    <div className={`dialpad ${disabled ? 'disabled' : ''}`}>
      <div className="display">
        <input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter a number"
          inputMode="tel"
          autoComplete="off"
          spellCheck="false"
          disabled={disabled}
        />
        {value && !disabled && (
          <button
            type="button"
            className="backspace"
            onClick={backspace}
            aria-label="Delete last digit"
          >
            ⌫
          </button>
        )}
      </div>

      <div className="keys">
        {KEYS.map((k) => (
          <button
            key={k.digit}
            type="button"
            className="key"
            onClick={() => press(k.digit)}
            disabled={disabled}
          >
            <span className="digit">{k.digit}</span>
            {k.letters && <span className="letters">{k.letters}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
