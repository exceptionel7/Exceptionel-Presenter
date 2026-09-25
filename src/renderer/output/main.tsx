import '../styles.css';
import { bootstrap } from '@ui/bootstrap.tsx';
import { OutputApp } from './OutputApp.tsx';

/*
 * No StrictMode: its double-invoked effects would open camera streams and restart video
 * playback twice on the audience screen.
 *
 * audienceSafe keeps failures black rather than painting a stack trace onto the projector.
 */
bootstrap(<OutputApp />, { role: 'output', audienceSafe: true });
