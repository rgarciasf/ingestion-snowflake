-- 01_setup.sql: warehouse, database and schemas for the Acme demo world.
-- Run as ACCOUNTADMIN (or a role with CREATE WAREHOUSE / CREATE DATABASE).

USE ROLE ACCOUNTADMIN;

CREATE WAREHOUSE IF NOT EXISTS ACME_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'Ingestion x Snowflake hackathon warehouse';

CREATE DATABASE IF NOT EXISTS ACME COMMENT = 'Fictional Acme (Pulse analytics SaaS). All data is synthetic.';
CREATE SCHEMA IF NOT EXISTS ACME.PULSE     COMMENT = 'Product + revenue data: workspaces, events, invoices, support tickets';
CREATE SCHEMA IF NOT EXISTS ACME.KNOWLEDGE COMMENT = 'Documents, policies and meeting transcripts (chunked for Cortex Search)';
CREATE SCHEMA IF NOT EXISTS ACME.BRAIN     COMMENT = 'What the agent writes back: commitments, risk alerts, traces';

USE WAREHOUSE ACME_WH;
USE DATABASE ACME;
