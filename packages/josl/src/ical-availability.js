//@ts-check

//#region availability layers
// A VAVAILABILITY (RFC 7953) is one bounded available layer of
// `@jarenjs/core/calendar`'s `evaluateAvailability`: its period is the
// layer's `bounds` (an absent DTSTART or DTEND an open end), its PRIORITY
// the layer's (0, or none, the lowest), and its AVAILABLE components the
// layer's series. Inside its period a bounded available layer is
// available where an AVAILABLE says so and busy elsewhere, of its
// BUSYTYPE (busy-unavailable by default), at its rank, which is §3.1's
// reading; a higher-ranked layer decides inside its own period over a
// lower one, and at one rank busy types combine as §4 orders them. The
// reader withholds what a layer cannot hold (`ICAL1025`), so every layer
// here answers as the RFC does.

/**
 * The availability layers of the VAVAILABILITY components among a read's
 * components, in the order read; every other component is passed over.
 * Each layer's id is its UID (a repeated UID gets `#1`, `#2`, ...), its
 * `bounds` the component's period, its `busyType` the component's
 * BUSYTYPE (left out when it has none: the layer's default is RFC 7953's
 * BUSY-UNAVAILABLE), and its series its AVAILABLE components'. Zoned times resolve through the provider and policy given
 * to `evaluateAvailability`: the read's `zones.provider`, which holds the
 * file's VTIMEZONEs, under `policy: 'rfc5545'`, RFC 5545's rule for a
 * wall clock and TZID. Time outside every component is unknown there, as
 * time no layer claims always is; RFC 7953 §5 starts a free/busy request
 * from free, which a lowest-ranked layer `{ id, priority: 0, mode:
 * 'available', spans: [{}], source }` beside these says.
 * @param {Iterable<Record<string, any>>} components - a read's `calendar.components`
 * @param {{ source?: string, revision?: string }} [options] - the layers' provenance token
 *   (`'icalendar'` when not given) and revision
 * @returns {import('@jarenjs/core/calendar').AvailabilityLayer[]}
 * @example
 * const { calendar, zones } = parseIcal(text, { provider });
 * const answer = evaluateAvailability(availabilityLayers(calendar.components),
 *   { horizon, provider: zones.provider, policy: 'rfc5545' });
 */
export function availabilityLayers(components, options = undefined) {
  const source = options?.source ?? 'icalendar';
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {any[]} */
  const layers = [];
  for (const component of components) {
    if (component === null || typeof component !== 'object' || component.type !== 'availability')
      continue;
    const n = seen.get(component.uid) ?? 0;
    seen.set(component.uid, n + 1);
    const series = component.available.map((/** @type {any} */ available) => available.series);
    layers.push({
      id: n === 0 ? component.uid : `${component.uid}#${n}`, priority: component.priority ?? 0, mode: 'available',
      bounds: [component.start ?? null, component.end ?? null], ...(component.busyType !== undefined ? { busyType: component.busyType } : {}),
      ...(series.length === 0 ? { spans: [] } : { series }),
      source, ...(options?.revision !== undefined ? { revision: options.revision } : {}),
    });
  }
  return layers;
}

//#endregion
