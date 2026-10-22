# Vehicle mileage and service reminders

Customer case pages provide a vehicle-care panel to record an odometer reading, review the latest 50 recorded revisions, set a service reminder by date and/or odometer threshold, and mark it done. The vehicle owner controls these reminders. They are in-app records; this feature does not send push, SMS or email.

Migration 089 preserves existing readings as baseline entries at migration time (not their original observation time). A database trigger records subsequent value/unit changes atomically, including changes through the existing technician confirmation path. Identical retries produce no extra reading. Corrections may lower the current value, while retaining previous values. This ledger is reported data, not proof of actual distance driven. Generic OBD speed readings are never treated as an odometer.

API:

- `GET /api/me/vehicles/:vehicleId/care`: recent history and reminders with computed due state.
- Existing vehicle `PATCH`: record value and unit together; choosing a unit without a reading is rejected.
- `POST /api/me/vehicles/:vehicleId/reminders`: client UUID `id`, `title`, optional ISO `dueDate`, optional integer `dueOdometer`, `odometerUnit` (`miles` default or `kilometers`). At least one threshold is required. Retry an identical UUID/body safely; conflicting reuse returns 409.
- `POST /api/me/vehicles/:vehicleId/reminders/:reminderId/complete`: idempotent completion.

All routes require the owning customer and an active saved vehicle. Existing actor vehicle projections remain unchanged. Due means either threshold has been reached. Date comparisons use UTC; distance comparisons use the exact conversion 1 mile = 1.609344 kilometres with Postgres numeric arithmetic. Unknown mileage does not satisfy a distance threshold. Completed reminders are never due. A vehicle can have at most 100 active reminders.

Intervals are chosen by the customer from their vehicle's service schedule. This release does not invent manufacturer recommendations, infer mileage between readings, certify readings, or automatically reconcile independent Shop OS repair-order odometer fields. Customer case vehicle confirmation already writes the canonical record and is captured by the ledger. Future work includes workshop-authored recommendations, observation timestamps and correction reasons, broader garage navigation, and notification delivery preferences.
