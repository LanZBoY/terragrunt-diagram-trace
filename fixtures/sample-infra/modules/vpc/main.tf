variable "cidr_block" { type = string }

output "vpc_id" { value = "vpc-xxxx" }
output "subnet_ids" { value = ["subnet-aaaa", "subnet-bbbb"] }
