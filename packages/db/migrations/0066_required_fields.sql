-- A field may ask for a value in every row written from now on: on forms,
-- in the grid, through the API, and in imports. Rows already written keep
-- what they hold until they are next changed.
ALTER TABLE data_columns ADD COLUMN required boolean NOT NULL DEFAULT false;
