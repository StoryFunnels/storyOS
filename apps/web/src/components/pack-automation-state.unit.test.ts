import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutomationStateLine, InstalledAutomationLine } from './pack-automation-state';
import type { AutomationPreviewItem } from '@/lib/pack-automation-state';

const email: AutomationPreviewItem = {
  name: 'Posts.Email me when a post is approved',
  enabled_on_install: false,
  switched_off_because: 'outward',
};

function render(item: AutomationPreviewItem, chosen = false, confirmed?: AutomationPreviewItem) {
  return renderToStaticMarkup(createElement(AutomationStateLine, { item, chosen, confirmed, onChoose: () => {} }));
}

describe('AutomationStateLine', () => {
  it('an off rule says off and why, and offers a switch that is OFF by default', () => {
    const html = render(email);
    expect(html).toContain('Off until you turn it on');
    expect(html).toContain('It sends things outside your workspace.');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('data-state="off"');
    expect(html).toContain('text-warning-text');
  });
  it('turned on: says on, keeps the reason, the switch reads checked', () => {
    const html = render(email, true);
    expect(html).toContain('On once installed');
    expect(html).toContain('You turned it on: it sends things outside your workspace.');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain('Off until');
  });
  it('a chosen label the server did not confirm renders off again', () => {
    expect(render(email, true, { name: email.name, enabled_on_install: false })).toContain('Off until you turn it on');
  });
  it('an internal rule says On once installed and has no switch', () => {
    const html = render({ name: 'Posts.Stamp', enabled_on_install: true });
    expect(html).toContain('On once installed');
    expect(html).not.toContain('role="switch"');
  });
  it('a rule that already exists draws nothing at all', () => {
    expect(render({ name: 'Posts.Already here' })).toBe('');
    expect(render({ name: 'Posts.Already here' }, true)).toBe('');
  });
  it('a rule the pack ships off says so, and still has a switch (the API honours it)', () => {
    const html = render({ name: 'Posts.Shipped off', enabled_on_install: false });
    expect(html).toContain('The pack ships it switched off.');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
  });
  it('uses no gold and no var() fallback', () => {
    expect(render(email)).not.toMatch(/gold|var\(--[a-z-]+,/);
  });
});

describe('InstalledAutomationLine', () => {
  const r = (entity: Parameters<typeof InstalledAutomationLine>[0]['entity']) =>
    renderToStaticMarkup(createElement(InstalledAutomationLine, { entity }));
  it('an automation created off says so and why, with no switch', () => {
    const html = r({ enabled: false, switched_off_because: 'outward' });
    expect(html).toContain('Off until you turn it on');
    expect(html).toContain('It sends things outside your workspace.');
    expect(html).not.toContain('role="switch"');
  });
  it('an automation created on says On', () => {
    const html = r({ enabled: true });
    expect(html).toContain('>On<');
    expect(html).not.toContain('Off until');
  });
  it('draws nothing when the result does not say', () => {
    expect(r({})).toBe('');
  });
});
