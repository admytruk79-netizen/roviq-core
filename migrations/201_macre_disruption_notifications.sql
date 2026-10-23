-- MACRE notification outbox: dedupe case + recipient + qualification alert.
create unique index if not exists macre_qualification_notice_unique
 on notification_outbox(case_id,recipient_id,template_key)
 where template_key='provider_qualification_disruption' and case_id is not null;
insert into notification_templates(template_key,channel,subject_template,body_template,active)
values ('provider_qualification_disruption','push','ROVIQ service review','A service assignment requires review. Please check your ROVIQ case.',true)
on conflict(template_key,channel,version) do nothing;
