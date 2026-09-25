import '../styles.css';
import { bootstrap } from '@ui/bootstrap.tsx';
import { App } from './App.tsx';

bootstrap(<App />, { role: 'operator', strict: true });
