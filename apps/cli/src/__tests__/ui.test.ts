import { describe, expect, it } from 'vitest';
import { renderEnvPanel, renderLogoWithEnvPanel } from '../ui.js';

const legacyOfficialDefaults = {
  ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-1-20250805',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-opus-4-1-20250805',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-3-5-haiku-20241022',
  ANTHROPIC_MODEL: 'opus',
};

describe('environment display', () => {
  it('shows untouched legacy official pins as Claude defaults', () => {
    const panel = renderEnvPanel('official', legacyOfficialDefaults);
    const logoPanel = renderLogoWithEnvPanel('official', legacyOfficialDefaults);

    expect(panel).toContain('Claude default');
    expect(panel).not.toContain('claude-opus-4-1-20250805');
    expect(logoPanel).toContain('Claude default');
    expect(logoPanel).not.toContain('claude-opus-4-1-20250805');
  });

  it('still shows legacy-looking pins for a customized official endpoint', () => {
    const customized = {
      ...legacyOfficialDefaults,
      ANTHROPIC_BASE_URL: 'https://partner.example.com/anthropic',
    };

    expect(renderEnvPanel('official', customized)).toContain(
      'claude-opus-4-1-20250805'
    );
  });
});
