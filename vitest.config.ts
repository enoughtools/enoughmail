import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'apps/mail/native/tests/**/*.test.ts'], environment: 'node' },
});
