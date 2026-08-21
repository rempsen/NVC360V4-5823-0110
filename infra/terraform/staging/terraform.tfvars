# Cost gates for the staging environment, set deliberately rather than by
# editing variable defaults — so `git log` shows who turned on spend and when.
#
# create_database = true, approved by Dan on 2026-08-21.
#   db.t4g.micro + 20 GB gp3 + 7-day backups. Free for the first 12 months on
#   this account, roughly $15/month after August 2027.
#
#   Turned on now rather than at Phase D because NVC360 does not own the Turso
#   account — it was provisioned by the hosting platform on our behalf, so
#   there is no dashboard we control, no backup we can take ourselves, and no
#   credential we can rotate. Owning a database outright is no longer just the
#   migration target, it is the contingency.
#
# create_service stays false: nothing runs until CI pushes a first image.
create_database = true
create_service  = false
