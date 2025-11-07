import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";

export class N8nStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Pre-allocate an EIP for the NAT, so you know exactly what to whitelist on digest (MM)
    const natEip = new ec2.CfnEIP(this, "NatEip", { domain: "vpc" });

    const natProvider = ec2.NatProvider.gateway({
      // If you already have an EIP allocation ID, put it here instead of creating one.
      eipAllocationIds: [natEip.attrAllocationId],
    });

    const vpc = new ec2.Vpc(this, "N8nVpc", {
      natGatewayProvider: natProvider,
      maxAzs: 2,
      natGateways: 1,
    });

    new cdk.CfnOutput(this, "OutboundStaticIp", {
      value: natEip.attrPublicIp,
      description: "Static outbound IP used by ECS tasks via NAT",
    });

    const cluster = new ecs.Cluster(this, "N8nCluster", {
      vpc,
    });

    const dbSecret = new secretsmanager.Secret(this, "N8nDbSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "n8n" }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });

    const dbCredsSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "N8nDbUserSecret",
      "arn:aws:secretsmanager:us-east-1:912142372862:secret:db-creds-N7KABz"
    );

    const n8nSecrets = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "N8nSecrets",
      "arn:aws:secretsmanager:us-east-1:912142372862:secret:mmn8n-prod-secrets-5X2Sc8"
    );

    const dbSecurityGroup = new ec2.SecurityGroup(this, "N8nDbSecurityGroup", {
      vpc,
      description: "Security group for n8n PostgreSQL database",
      allowAllOutbound: true,
    });

    const dbParameterGroup = new rds.ParameterGroup(
      this,
      "N8nDbParameterGroup",
      {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_17,
        }),
        parameters: {
          "rds.force_ssl": "0",
        },
      }
    );
    // the base props ECS needs to run tasks on our containers
    const baseRoleProps: iam.RoleProps = {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "managed-ecs-task-exec-role-policy",
          "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    };
    const ecsBastionSecurityGroup = new ec2.SecurityGroup(
      this,
      "ecs-bastion-sg",
      {
        vpc,
      }
    );
    // allows ssh access to our bastion service
    ecsBastionSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "SSH"
    );
    const bastionExecRole = new iam.Role(
      this,
      "ecs-bastion-exec-role",
      baseRoleProps
    );
    const bastionImage = ecs.ContainerImage.fromAsset("bastion");
    const bastionTaskDefn = new ecs.TaskDefinition(this, "bastion-task-def", {
      compatibility: ecs.Compatibility.FARGATE,
      executionRole: bastionExecRole,
      cpu: "256",
      memoryMiB: "512",
    });
    bastionTaskDefn.addContainer("bastion-container", {
      image: bastionImage,
      portMappings: [
        {
          containerPort: 22,
          hostPort: 22,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });
    new ecs.FargateService(this, "bastion-fargate-service", {
      cluster,
      securityGroups: [ecsBastionSecurityGroup],
      vpcSubnets: {
        subnets: vpc.publicSubnets,
      },
      desiredCount: 1,
      assignPublicIp: true,
      taskDefinition: bastionTaskDefn,
    });

    const dbInstance = new rds.DatabaseInstance(this, "N8nDbInstance", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "n8n",
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      publiclyAccessible: true,
      autoMinorVersionUpgrade: true,
      deleteAutomatedBackups: true,
      enablePerformanceInsights: true,
      storageEncrypted: true,
      port: 5432,
      parameterGroup: dbParameterGroup,
    });

    const certificate = certificatemanager.Certificate.fromCertificateArn(
      this,
      "cert",
      "arn:aws:acm:us-east-1:912142372862:certificate/c3cf923a-cfb5-411b-a98f-e16484623a70"
    );

    const n8nService = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      "N8nService",
      {
        cluster,
        memoryLimitMiB: 2048,
        cpu: 1024,
        desiredCount: 2,
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry("n8nio/n8n:latest"),
          containerPort: 5678,
          environment: {},
          secrets: {
            DB_POSTGRESDB_PASSWORD: ecs.Secret.fromSecretsManager(
              dbCredsSecret,
              "DB_PASSWORD"
            ),
            N8N_HOST: ecs.Secret.fromSecretsManager(n8nSecrets, "DOMAIN_NAME"),
            N8N_EDITOR_BASE_URL: ecs.Secret.fromSecretsManager(
              n8nSecrets,
              "N8N_URL"
            ),
            N8N_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(
              n8nSecrets,
              "N8N_ENCRYPTION_KEY"
            ),
            WEBHOOK_URL: ecs.Secret.fromSecretsManager(n8nSecrets, "N8N_URL"),
            GMAIL_CLIENT_ID: ecs.Secret.fromSecretsManager(
              n8nSecrets,
              "GMAIL_CLIENT_ID"
            ),
            GMAIL_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
              n8nSecrets,
              "GMAIL_CLIENT_SECRET"
            ),
            GMAIL_REDIRECT_URI: ecs.Secret.fromSecretsManager(
              n8nSecrets,
              "GMAIL_REDIRECT_URI"
            ),
            GMAIL_SCOPES: ecs.Secret.fromSecretsManager(
              n8nSecrets,
              "GMAIL_SCOPES"
            ),
          },
        },
        publicLoadBalancer: true,
        certificate,
        assignPublicIp: false,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        listenerPort: 443,
      }
    );

    n8nService.loadBalancer.addListener("HttpRedirectListener", {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: "443",
        protocol: elbv2.ApplicationProtocol.HTTPS,
        permanent: true,
      }),
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    const container = n8nService.taskDefinition.defaultContainer;
    if (container) {
      const envVars: Record<string, string> = {
        N8N_PORT: "5678",
        N8N_PROTOCOL: "https",
        N8N_REINSTALL_MISSING_PACKAGES: "true",
        DB_TYPE: "postgresdb",
        DB_POSTGRESDB_HOST: dbInstance.dbInstanceEndpointAddress,
        DB_POSTGRESDB_PORT: "5432",
        DB_POSTGRESDB_DATABASE: "n8n",
        DB_POSTGRESDB_USER: "postgres",
        DB_POSTGRESDB_SSL: "false",
        DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: "false",
      };

      Object.entries(envVars).forEach(([key, value]) => {
        container.addEnvironment(key, value);
      });
    }

    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      "Allow PostgreSQL access from VPC"
    );

    n8nService.service.connections.allowFromAnyIpv4(ec2.Port.tcp(5678));

    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: n8nService.loadBalancer.loadBalancerDnsName,
    });
  }
}
