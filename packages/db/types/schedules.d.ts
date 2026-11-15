/** The calendar half of recurring job schedules: opaque, recognized by the store. */
export interface JobSchedules {
  readonly read: Function;
  readonly definitionOfRow: Function;
  readonly occurrencesAfter: Function;
}

/** Enable recurring job schedules on a store: pass the answer as
 * `openStore(model, { jobs: { schedules: jobSchedules() } })`. */
export declare function jobSchedules(): JobSchedules;
