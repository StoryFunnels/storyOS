import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScheduleCadenceControls } from './schedule-cadence-controls';

const noop = () => {};
const render = (props: Partial<Parameters<typeof ScheduleCadenceControls>[0]>) =>
  renderToStaticMarkup(
    createElement(ScheduleCadenceControls, { every: 'day', onEvery: noop, at: '09:00', onAt: noop, minutesText: '', onMinutesText: noop, ...props }),
  );

/** Ticket #1318 — a rule saved with a minutes interval opens showing it. */
describe('#1318 the editor shows an every-N-minutes rule', () => {
  it('names the interval in the menu and holds it in the box', () => {
    const html = render({ every: 'minutes', minutesText: '45' });
    // The menu's own label, not any text containing the phrase: the note under it also says "every 45 minutes" for this interval.
    expect(html).toMatch(/text-left">every 45 minutes<\/span>/);
    expect(html).toMatch(/aria-label="Minutes between runs"[^>]*value="45"|value="45"[^>]*aria-label="Minutes between runs"/);
  });

  it('says when it runs, in the rule\'s own zone', () => {
    const html = render({ every: 'minutes', minutesText: '30', trigger: { timezone: 'Europe/London' } });
    expect(html).toContain('Runs at :00 and :30 past the hour in Europe/London.');
  });

  it('turns the box red and says why for an interval the API would refuse', () => {
    const html = render({ every: 'minutes', minutesText: '5' });
    expect(html).toContain('A schedule can run at most every 10 minutes.');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('border-error');
  });

  it('offers the four cadences, and the interval box only for minutes', () => {
    const hourly = render({ every: 'hour' });
    expect(hourly).toContain('every hour');
    expect(hourly).not.toContain('Minutes between runs');
    expect(render({ every: 'minutes', minutesText: '30' })).toContain('Minutes between runs');
  });

  it('shows a time-of-day menu for a daily or weekly rule, and neither for hourly or minutes', () => {
    expect(render({ every: 'day', at: '09:10' })).toContain('Time of day');
    expect(render({ every: 'week', at: '17:30' })).toContain('17:30');
    expect(render({ every: 'hour' })).not.toContain('Time of day');
    expect(render({ every: 'minutes', minutesText: '30' })).not.toContain('Time of day');
  });
});
