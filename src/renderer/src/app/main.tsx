import { createRoot } from 'react-dom/client';
import type { MainView } from '../../../shared/ipc';
import { App } from './App';
import './app.css';

const raw = new URLSearchParams(window.location.search).get('view');
const view: MainView = raw === 'settings' || raw === 'setup' ? raw : 'schedule';

createRoot(document.getElementById('root')!).render(<App api={window.api} view={view} />);
