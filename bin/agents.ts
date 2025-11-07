#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { N8nStack } from "../lib/n8n-stack";

const app = new cdk.App();
new N8nStack(app, "N8nStack");
