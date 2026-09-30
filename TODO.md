# TODO

## Setup UI (replaces the raw JSON editor)

Form-based commute setup so other people can configure the app without knowing GTFS IDs.

- [ ] Per commute: name, ordered legs (walk / transit / transfer), add/remove/reorder.
- [ ] Transit leg: route picker (`/routes?filter[type]=0,1,3`), direction picker using
  `direction_names` / `direction_destinations`, stop picker listing the route's stops in
  that direction (`/stops?filter[route]=...&filter[direction_id]=...`) with a search box.
- [ ] Role selection: exactly one bottleneck per commute; optional connection before it;
  filler legs ask for ride minutes.
- [ ] Global fields: direction cutoff, stop slack, API key.
- [ ] Validate with `validateConfig` and `checkStops` (see `verifyStops` in `index.html`) before saving.
- [ ] Keep JSON import/export as an advanced option (backup and sharing).
- [ ] Unit-test any new pure helpers in `core.js`.
