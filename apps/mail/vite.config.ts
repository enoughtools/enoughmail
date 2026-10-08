import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({ base: '/apps/mail/', plugins: [react()], build: { outDir: mode === 'standalone' ? 'dist-standalone' : 'dist' } }));
