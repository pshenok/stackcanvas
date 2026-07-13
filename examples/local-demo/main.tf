# Zero-credential demo: real Terraform state without touching any cloud.
# terraform init && terraform apply -auto-approve   — safe, creates local files only.
terraform {
  required_providers {
    random = { source = "hashicorp/random" }
    local  = { source = "hashicorp/local" }
  }
}

resource "random_pet" "app_name" {
  length = 2
}

resource "random_password" "db_password" {
  length  = 16
  special = false
}

resource "local_file" "config" {
  filename = "${path.module}/generated/config.txt"
  content  = "app=${random_pet.app_name.id}"
}
