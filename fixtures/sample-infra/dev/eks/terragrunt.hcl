include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "${local.region_vars.locals.modules_base}//eks?ref=v3.1.0"
}

dependency "vpc" {
  config_path = "../vpc"

  mock_outputs = {
    vpc_id     = "vpc-mock"
    subnet_ids = ["subnet-mock"]
  }
}

inputs = {
  vpc_id     = dependency.vpc.outputs.vpc_id
  subnet_ids = dependency.vpc.outputs.subnet_ids
}
