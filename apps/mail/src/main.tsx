import { StrictMode } from 'react';
import {createRoot} from 'react-dom/client';
import MailApp from './ui/MailApp';
import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><MailApp/></StrictMode>);
