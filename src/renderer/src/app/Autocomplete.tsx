import { useState } from 'react';

const LIMIT = 50;

export function Autocomplete({ label, options, value, onChange }: {
  label: string; options: string[]; value: string | null; onChange(v: string | null): void;
}) {
  const [query, setQuery] = useState(value ?? '');
  const q = query.trim().toLowerCase();
  const shown = (q ? options.filter(o => o.toLowerCase().includes(q)) : options).slice(0, LIMIT);
  return (
    <div className="autocomplete">
      <input
        role="combobox" aria-label={label} aria-expanded="true" aria-controls={`ac-${label}`} aria-autocomplete="list"
        value={query} placeholder="Почніть вводити…" autoFocus
        onChange={e => {
          const v = e.target.value;
          setQuery(v);
          onChange(options.includes(v) ? v : null);
        }}
      />
      <div className="options" role="listbox" id={`ac-${label}`} aria-label={label}>
        {shown.map(o => (
          <button
            type="button" role="option" key={o} aria-selected={o === value}
            className={o === value ? 'option selected' : 'option'}
            onClick={() => { setQuery(o); onChange(o); }}
          >{o}</button>
        ))}
        {shown.length === 0 && <div className="empty">Нічого не знайдено</div>}
      </div>
    </div>
  );
}
