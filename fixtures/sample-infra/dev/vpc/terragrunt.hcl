include "root" {
  path   = find_in_parent_folders("root.hcl")
  expose = true
}

include "env" {
  path = find_in_parent_folders("env.hcl")
}

terraform {
  source = "../../modules//vpc"
}

inputs = {
  cidr_block = "10.0.0.0/16"
}
