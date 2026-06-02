import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // core/shared modules are pure (no `vscode`); they run directly under Node.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Emit the default console reporter plus a JUnit XML the CI publishes as a report.
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/shared/**'],
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});