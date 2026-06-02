variable "vpc_id" { type = string }

output "endpoint" { value = "rds.internal:5432" }
