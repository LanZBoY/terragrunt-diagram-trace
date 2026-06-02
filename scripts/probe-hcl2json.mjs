import { parse } from "@cdktf/hcl2json";

const samples = {
  // 1) dependency block with literal relative path
  "dependency-literal": `
dependency "vpc" {
  config_path = "../vpc"
}
dependency "eks" {
  config_path = "../../clusters/eks"
  mock_outputs = { id = "mock" }
}
`,
  // 2) dependencies block (run-order only)
  "dependencies-block": `
dependencies {
  paths = ["../redis", "../rds", "../../shared/kms"]
}
`,
  // 3) include block with find_in_parent_folders()
  "include-fipf": `
include "root" {
  path = find_in_parent_folders()
}
include "region" {
  path = find_in_parent_folders("region.hcl")
}
`,
  // 4) terraform source - local and remote
  "terraform-source-local": `
terraform {
  source = "../../modules//app"
}
`,
  "terraform-source-remote": `
terraform {
  source = "git::git@github.com:acme/infra.git//modules/app?ref=v1.2.3"
}
`,
  // 5) interpolation in config_path using functions
  "config-path-interp": `
dependency "db" {
  config_path = "\${get_terragrunt_dir()}/../db"
}
locals {
  env = "prod"
}
dependency "svc" {
  config_path = "../\${local.env}/svc"
}
`,
  // 6) full realistic file with locals + include + multiple deps
  "realistic": `
locals {
  region_vars = read_terragrunt_config(find_in_parent_folders("region.hcl"))
  account     = "123456789012"
}
include "root" {
  path   = find_in_parent_folders()
  expose = true
}
terraform {
  source = "\${local.region_vars.locals.modules_base}//networking?ref=v2"
}
dependency "vpc" {
  config_path                             = "../vpc"
  skip_outputs                            = false
}
dependencies {
  paths = ["../iam", "../logging"]
}
inputs = {
  vpc_id = dependency.vpc.outputs.vpc_id
}
`,
};

for (const [name, hcl] of Object.entries(samples)) {
  try {
    const out = await parse(`${name}.hcl`, hcl);
    console.log(`\n================ ${name} ================`);
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.log(`\n================ ${name} (ERROR) ================`);
    console.log(String(e && e.stack ? e.stack : e));
  }
}
console.log("\n=== DONE ===");
