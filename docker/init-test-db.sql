-- Runs once, the first time the Postgres container starts with an empty volume.
-- The end-to-end tests use this separate database and wipe it on every run.
CREATE DATABASE bitebox_test OWNER bitebox;
