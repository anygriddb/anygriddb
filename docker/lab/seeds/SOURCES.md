# Sample database seed sources

| Dataset        | Upstream                                          | Version / pin              | License notes                         |
| -------------- | ------------------------------------------------- | -------------------------- | ------------------------------------- |
| Chinook        | https://github.com/lerocha/chinook-database       | v1.4.5                     | MIT                                   |
| Northwind      | https://github.com/harryho/db-samples             | commit 9bd103f             | Microsoft sample ports; see upstream  |
| Sakila         | https://downloads.mysql.com/docs/sakila-db.tar.gz | current MySQL docs package | Oracle/MySQL sample                   |
| Pagila         | https://github.com/devrimgunduz/pagila            | pagila-v3.1.0              | BSD-2-Clause                          |
| AdventureWorks | microsoft/sql-server-samples                      | AdventureWorks2022.bak     | Microsoft sample; local download only |

`scripts/lab/fetch-seeds.sh` downloads them and checks each SHA-256. It
derives the MySQL Northwind with a one-line primary-key fix, so that
`OrderDetail.orderId` can reference `SalesOrder.orderId` under InnoDB, and
the MariaDB one with `utf8mb4_unicode_ci` in place of MySQL's
`utf8mb4_0900_ai_ci`.
