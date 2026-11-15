-- More stores read from a copy (ADR 0088): the Redis wire protocol,
-- Cassandra, and Neo4j. Each is listed and copied; nothing is written
-- to the store. OpenSearch is already a value of this type.
ALTER TYPE "public"."source_engine" ADD VALUE 'redis';--> statement-breakpoint
ALTER TYPE "public"."source_engine" ADD VALUE 'cassandra';--> statement-breakpoint
ALTER TYPE "public"."source_engine" ADD VALUE 'neo4j';
