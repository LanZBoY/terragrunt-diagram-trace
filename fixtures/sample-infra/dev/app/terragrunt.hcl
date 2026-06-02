include "root" {
  path = find_in_parent_folders("root.hcl")
}

include "env" {
  path = find_in_parent_folders("env.hcl")
}

terraform {
  source = "../../modules//app"
}

dependency "eks" {
  config_path = "../eks"
}

dependency "rds" {
  config_path = "../rds"
}

# Pure run-order dependency: logging must apply before app, but app reads no outputs.
dependencies {
  paths = ["../logging"]
}

inputs = {
  
  cluster_name = dependency.eks.outputs.cluster_name
  db_endpoint  = dependency.rds.outputs.endpoint
}
