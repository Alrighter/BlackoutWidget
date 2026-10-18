import { useId, useState, type ReactNode } from 'react';

const LIMIT = 50;

/** `text` with the first occurrence of `q` (lower case) in bold. */
function withMatch(text: string, q: string): ReactNode {
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return text;
  return <>{text.slice(0, at)}<b>{text.slice(at, at + q.length)}</b>{text.slice(at + q.length)}</>;
}

/** A labelled field with the matching options listed under it (setup-wizard.html). */
export function Autocomplete({ label, options, value, onChange }: {
  label: string; options: string[]; value: string | null; onChange(v: string | null): void;
}) {
  const id = useId();
  const [query, setQuery] = useState(value ?? '');
  const q = query.trim().toLowerCase();
  const shown = (q ? options.filter(o => o.toLowerCase().includes(q)) : options).slice(0, LIMIT);
  return (
    <>
      <label className="st-label wz-label" htmlFor={`${id}-input`}>{label}</label>
      <input
        id={`${id}-input`} className="st-input wz-input"
        role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
        value={query} placeholder="Почніть вводити…" autoFocus
        onChange={e => {
          const v = e.target.value;
          setQuery(v);
          onChange(options.includes(v) ? v : null);
        }}
      />
      <div className="wz-list" role="listbox" id={`${id}-list`} aria-label={label} data-capture="options">
        {shown.map(o => (
          <button
            type="button" role="option" key={o} aria-selected={o === value} className="wz-option"
            onClick={() => { setQuery(o); onChange(o); }}
          ><span>{withMatch(o, q)}</span></button>
        ))}
        {shown.length === 0 && <div className="wz-empty">Нічого не знайдено</div>}
      </div>
    </>
  );
}
