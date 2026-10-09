import type { Language } from './types';

export const TERRAFORM: Language = {
  id: 'terraform',
  label: 'Terraform',
  runtimes: [{ name: 'terraform', commands: ['terraform'] }],
  markers: ['main.tf', 'provider.tf', 'backend.tf', 'terraform.tfvars', '.terraform.lock.hcl'],
  extensions: ['.tf'],
  commands: {
    test: (tf) => [tf, 'validate'],
    build: (tf) => [tf, 'fmt', '-check'],
    check: (tf) => [tf, 'validate'],
    lint: (tf) => [tf, 'validate'],
    run: (tf) => [tf, 'plan'],
  },
};
