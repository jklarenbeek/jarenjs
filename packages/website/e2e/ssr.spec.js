//@ts-check
import { test, expect } from '@playwright/test';
import { renderToString } from '../../view/src/index.js';

test('controlled select serialization restores the selected values when HTML is parsed', async ({ page }) => {
  const html = renderToString(['div', {},
    ['select', { id: 'single', value: 'b' },
      ['option', { value: 'a', selected: true }, 'A'],
      ['optgroup', { label: 'Group' }, ['option', { value: 'b' }, 'B'], ['option', { value: 'b' }, 'Duplicate']]],
    ['select', { id: 'multiple', multiple: true, value: ['a', 'Text value'] },
      ['option', { value: 'a' }, 'A'], ['option', { value: 'b', selected: true }, 'B'],
      ['option', {}, ' Text\n value ']],
  ]);
  await page.setContent(html);
  expect(await page.locator('#single').inputValue()).toBe('b');
  expect(await page.locator('#single').evaluate((node) => /** @type {HTMLSelectElement} */ (node).selectedIndex)).toBe(1);
  expect(await page.locator('#multiple').evaluate((node) =>
    [.../** @type {HTMLSelectElement} */ (node).selectedOptions].map((option) => option.value))).toEqual(['a', 'Text value']);
});
