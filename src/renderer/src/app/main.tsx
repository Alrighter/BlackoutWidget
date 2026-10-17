import { createRoot } from 'react-dom/client';

const view = new URLSearchParams(window.location.search).get('view') ?? 'schedule';

createRoot(document.getElementById('root')!).render(<div>Графік відключень — {view}</div>);
