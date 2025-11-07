# n8n on AWS ECS

This project deploys n8n (workflow automation tool) on AWS ECS Fargate with HTTPS support.

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js and npm installed
- AWS CDK installed (`npm install -g aws-cdk`)

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Deployment

1. Bootstrap your AWS environment (if not already done):

   ```bash
   cdk bootstrap aws://YOUR_ACCOUNT_ID/YOUR_REGION
   ```

2. Deploy the stack:

   ```bash
   cdk deploy
   ```

3. Set up your aws profile for the specific n8n subaccount
