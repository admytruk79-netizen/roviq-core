create unique index if not exists shop_waitlist_entries_booked_appointment_uidx
  on shop_waitlist_entries(booked_appointment_id)
  where state='booked' and booked_appointment_id is not null;
