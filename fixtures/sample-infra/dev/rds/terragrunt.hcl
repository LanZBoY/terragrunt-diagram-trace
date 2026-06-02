include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules//rds"
}

dependency "vpc" {
  config_path = "../vpc"
}

inputs = {
  vpc_id = dependency.vpc.outputs.vpc_id
}
