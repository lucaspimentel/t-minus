# TODO

## Next

- [ ] **Next-day departures after service ends.** After the last bus, the list says
  "No upcoming departures". Show the first departure of the next service day instead
  (fetch schedules for the next service date when the current window is empty).
- [ ] **Separate source badge for the train.** Office → home rows show one badge for
  bus + train combined (weakest wins), so a live bus with a scheduled train reads as
  "scheduled". Show the train's badge next to the train time.
- [ ] **Config sanity check against the API.** A config with valid shape but wrong stop
  IDs or direction silently yields no departures. After saving, verify each configured
  stop exists and is served by its route/direction (`/stops/<id>`, `/stops?filter[route]=...&filter[direction_id]=...`)
  and show an error for mismatches.

## Setup UI (replaces the raw JSON editor)

Form-based commute setup so other people can configure the app without knowing GTFS IDs.

- [ ] Per commute: name, ordered legs (walk / transit / transfer), add/remove/reorder.
- [ ] Transit leg: route picker (`/routes?filter[type]=0,1,3`), direction picker using
  `direction_names` / `direction_destinations`, stop picker listing the route's stops in
  that direction (`/stops?filter[route]=...&filter[direction_id]=...`) with a search box.
- [ ] Role selection: exactly one bottleneck per commute; optional connection before it;
  filler legs ask for ride minutes.
- [ ] Global fields: direction cutoff, stop slack, API key.
- [ ] Validate with `validateConfig` and the API sanity check before saving.
- [ ] Keep JSON import/export as an advanced option (backup and sharing).
- [ ] Unit-test any new pure helpers in `core.js`.
