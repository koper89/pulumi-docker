// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as pulumi from "@pulumi/pulumi";
import {ResourceError} from "@pulumi/pulumi/errors";
import * as utils from "./utils";

import * as child_process from "child_process";
import * as semver from "semver";

// Registry is the information required to login to a Docker registry.
export interface Registry {
    registry: pulumi.Input<string>;
    username: pulumi.Input<string>;
    password: pulumi.Input<string>;
}

/**
 * CacheFrom may be used to specify build stages to use for the Docker build cache. The final image
 * is always implicitly included.
 */
export interface CacheFrom {
    /**
     * An optional list of build stages to use for caching. Each build stage in this list will be
     * built explicitly and pushed to the target repository. A given stage's image will be tagged as
     * "[stage-name]".
     */
    stages?: pulumi.Input<pulumi.Input<string>[]>;
}

/**
 * DockerBuild may be used to specify detailed instructions about how to build a container.
 */
export interface DockerBuild {
    /**
     * context is a path to a directory to use for the Docker build context, usually the directory
     * in which the Dockerfile resides (although dockerfile may be used to choose a custom location
     * independent of this choice). If not specified, the context defaults to the current working
     * directory; if a relative path is used, it is relative to the current working directory that
     * Pulumi is evaluating.
     */
    context?: pulumi.Input<string>;

    /**
     * dockerfile may be used to override the default Dockerfile name and/or location.  By default,
     * it is assumed to be a file named Dockerfile in the root of the build context.
     */
    dockerfile?: pulumi.Input<string>;

    /**
     * An optional map of named build-time argument variables to set during the Docker build.  This
     * flag allows you to pass built-time variables that can be accessed like environment variables
     * inside the `RUN` instruction.
     */
    args?: pulumi.Input<Record<string, pulumi.Input<string>>>;

    /**
     * An optional CacheFrom object with information about the build stages to use for the Docker
     * build cache. This parameter maps to the --cache-from argument to the Docker CLI. If this
     * parameter is `true`, only the final image will be pulled and passed to --cache-from; if it is
     * a CacheFrom object, the stages named therein will also be pulled and passed to --cache-from.
     */
    cacheFrom?: pulumi.Input<boolean | CacheFrom>;

    /**
     * An optional catch-all string to provide extra CLI options to the docker build command.  For
     * example, use to specify `--network host`.
     */
    extraOptions?: pulumi.Input<pulumi.Input<string>[]>;

    /**
     * Environment variables to set on the invocation of `docker build`, for example to support
     * `DOCKER_BUILDKIT=1 docker build`.
     */
    env?: Record<string, string>;
}

let dockerPasswordPromise: Promise<boolean> | undefined;

function useDockerPasswordStdin(logResource: pulumi.Resource) {
    if (!dockerPasswordPromise) {
        dockerPasswordPromise = useDockerPasswordStdinWorker();
    }

    return dockerPasswordPromise;

    async function useDockerPasswordStdinWorker() {
        // Verify that 'docker' is on the PATH and get the client/server versions
        let dockerVersionString: string;
        try {
            dockerVersionString = await runCommandThatMustSucceed(
                "docker", ["version", "-f", "{{json .}}"], logResource);
            // IDEA: In the future we could warn here on out-of-date versions of Docker which may not support key
            // features we want to use.

            pulumi.log.debug(`'docker version' => ${dockerVersionString}`, logResource);
        } catch (err) {
            throw new ResourceError("No 'docker' command available on PATH: Please install to use container 'build' mode.", logResource);
        }

        // Decide whether to use --password or --password-stdin based on the client version.
        try {
            const versionData: any = JSON.parse(dockerVersionString!);
            const clientVersion: string = versionData.Client.Version;
            return semver.gte(clientVersion, "17.07.0", true);
        } catch (err) {
            pulumi.log.info(`Could not process Docker version (${err})`, logResource);
        }

        return false;
    }
}

/**
 * @deprecated Use [buildAndPushImage] instead.  This function loses the Output resource tracking
 * information from [pathOrBuild] and [repositoryUrl].  [buildAndPushImage] properly keeps track of
 * this in the result.
 */
export function buildAndPushImageAsync(
    baseImageName: string,
    pathOrBuild: pulumi.Input<string | DockerBuild>,
    repositoryUrl: pulumi.Input<string>,
    logResource: pulumi.Resource,
    skipPush: boolean,
    connectToRegistry?: () => pulumi.Input<Registry>): Promise<string> {

    const output = buildAndPushImage(baseImageName, pathOrBuild, repositoryUrl, logResource, skipPush, connectToRegistry);

    // Ugly, but necessary to bridge between the proper Output-returning function and this
    // Promise-returning one.
    return (<any>output).promise();
}

/**
 * buildAndPushImage will build and push the Dockerfile and context from [pathOrBuild] into the
 * requested docker repo [repositoryUrl].  It returns the unique target image name for the image in
 * the docker repository.  During preview this will build the image, and return the target image
 * name, without pushing. During a normal update, it will do the same, as well as tag and push the
 * image.
 */
export function buildAndPushImage(
    imageName: string,
    pathOrBuild: pulumi.Input<string | DockerBuild>,
    repositoryUrl: pulumi.Input<string>,
    logResource: pulumi.Resource,
    skipPush: boolean,
    connectToRegistry?: () => pulumi.Input<Registry>): pulumi.Output<string> {

    return pulumi.all([pathOrBuild, repositoryUrl])
        .apply(async ([pathOrBuildVal, repositoryUrlVal]) => {

            // Give an initial message indicating what we're about to do.  That way, if anything
            // takes a while, the user has an idea about what's going on.
            logEphemeral("Starting docker build and push...", logResource);

            const result = await buildAndPushImageWorkerAsync(
                imageName, pathOrBuildVal, repositoryUrlVal, logResource, skipPush, connectToRegistry);

            // If we got here, then building/pushing didn't throw any errors.  Update the status bar
            // indicating that things worked properly.  That way, the info bar isn't stuck showing the very
            // last thing printed by some subcommand we launched.
            logEphemeral("Successfully pushed to docker", logResource);

            return result;
        });
}

function logEphemeral(message: string, logResource: pulumi.Resource) {
    pulumi.log.info(message, logResource, /*streamId:*/ undefined, /*ephemeral:*/ true);
}

/** @internal for testing purposes */
export function checkRepositoryUrl(repositoryUrl: string) {
    const { tag } = utils.getImageNameAndTag(repositoryUrl);

    // We want to report an advisory error to users so that they don't accidentally include a 'tag'
    // in the repo url they supply.  i.e. their repo url can be:
    //
    //      docker.mycompany.com/namespace/myimage
    //
    // but should not be:
    //
    //      docker.mycompany.com/namespace/myimage:latest
    //
    // We could consider removing this check entirely.  However, it is likely valuable to catch
    // clear mistakes where a tag was included in a repo url inappropriately.
    //
    // However, since we do have the check, we need to ensure that we do allow the user to specify
    // a *port* on their repository that the are communicating with.  i.e. it's fine to have:
    //
    //      docker.mycompany.com:5000 or
    //      docker.mycompany.com:5000/namespace/myimage
    //
    // So check if this actually does look like a port, and don't report an error in that case.
    //
    // From: https://www.w3.org/Addressing/URL/url-spec.txt
    //
    //      port        digits
    //
    // Regex = any number of digits, optionally followed by / and any remainder.
    if (tag && !/^\d+(\/.*)?/g.test(tag)) {
        throw new Error(`[repositoryUrl] should not contain a tag: ${tag}`);
    }
}

async function buildAndPushImageWorkerAsync(
    baseImageName: string,
    pathOrBuild: string | pulumi.Unwrap<DockerBuild>,
    repositoryUrl: string,
    logResource: pulumi.Resource,
    skipPush: boolean,
    connectToRegistry: (() => pulumi.Input<Registry>) | undefined): Promise<string> {

    checkRepositoryUrl(repositoryUrl);

    const tag = utils.getImageNameAndTag(baseImageName).tag;

    // login immediately if we're going to have to actually communicate with a remote registry.
    //
    // We know we have to login if:
    //
    //  1. We're doing an update.  In that case, we'll always want to login so we can push our
    //     images to the remote registry.
    //
    // 2. We're in preview or update and the build information contains 'cache from' information. In
    //    that case, we'll want want to pull from the registry and will need to login for that.
    //
    // Logging in immediately also helps us side-step a strange issue we've seen downstream where
    // Node can be unhappy if we try to call connectToRegistry (which may end up calling deasync'ed
    // invoke calls) *after* we've spawned some calls to docker builds.  Front-loading this step
    // seems to avoid all those issues.

    const pullFromCache = typeof pathOrBuild !== "string" && pathOrBuild && pathOrBuild.cacheFrom && !!repositoryUrl;

    // If no `connectToRegistry` function was passed in we simply assume docker is already
    // logged-in to the correct registry (or uses auto-login via credential helpers).
    if (connectToRegistry) {
        if (!pulumi.runtime.isDryRun() || pullFromCache) {
            logEphemeral("Logging in to registry...", logResource);
            const registryOutput = pulumi.output(connectToRegistry());
            const registry: pulumi.Unwrap<Registry> = await (<any>registryOutput).promise();
            await loginToRegistry(registry, logResource);
        }
    }

    // If the container specified a cacheFrom parameter, first set up the cached stages.
    let cacheFrom = Promise.resolve<string[] | undefined>(undefined);
    if (pullFromCache) {
        const dockerBuild = <pulumi.UnwrappedObject<DockerBuild>>pathOrBuild;
        const cacheFromParam = (typeof dockerBuild.cacheFrom === "boolean" ? {} : dockerBuild.cacheFrom) || {};
        cacheFrom = pullCacheAsync(baseImageName, cacheFromParam, repositoryUrl, logResource);
    }

    // Next, build the image.
    const {imageId, stages} = await buildImageAsync(baseImageName, pathOrBuild, logResource, cacheFrom);
    if (imageId === undefined) {
        throw new Error("Internal error: docker build did not produce an imageId.");
    }

    // Generate a name that uniquely will identify this built image.  This is similar in purpose to
    // the name@digest form that can be normally be retrieved from a docker repository.  However,
    // this tag doesn't require actually pushing the image, nor does it require communicating with
    // some external system, making it suitable for unique identification, even during preview.
    // This also means that if docker produces a new imageId, we'll get a new name here, ensuring that
    // resources (like docker.Image and cloud.Service) will be appropriately replaced.
    const uniqueTaggedImageName = createTaggedImageName(repositoryUrl, tag, imageId);

    // Use those to push the image.  Then just return the unique target name. as the final result
    // for our caller to use. Only push the image during an update, do not push during a preview.
    if (!pulumi.runtime.isDryRun() && !skipPush) {
        // Push the final image first, then push the stage images to use for caching.

        // First, push with both the optionally-requested-tag *and* imageId (which is guaranteed to
        // be defined).  By using the imageId we give the image a fully unique location that we can
        // successfully pull regardless of whatever else has happened at this repositoryUrl.

        // Next, push only with the optionally-requested-tag.  Users of this API still want to get a
        // nice and simple url that they can reach this image at, without having the explicit imageId
        // hash added to it.  Note: this location is not guaranteed to be idempotent.  For example,
        // pushes on other machines might overwrite that location.
        await tagAndPushImageAsync(baseImageName, repositoryUrl, tag, imageId, logResource);
        await tagAndPushImageAsync(baseImageName, repositoryUrl, tag, /*imageId:*/ undefined, logResource);

        for (const stage of stages) {
            await tagAndPushImageAsync(
                localStageImageName(baseImageName, stage), repositoryUrl, stage, /*imageId:*/ undefined, logResource);
        }
    }

    return uniqueTaggedImageName;
}

function localStageImageName(imageName: string, stage: string) {
    return `${imageName}-${stage}`;
}

function createTaggedImageName(repositoryUrl: string, tag: string | undefined, imageId: string | undefined): string {
    const pieces: string[] = [];
    if (tag) {
        pieces.push(tag);
    }

    if (imageId) {
        pieces.push(imageId);
    }

    // Note: we don't do any validation that the tag is well formed, as per:
    // https://docs.docker.com/engine/reference/commandline/tag
    //
    // If there are any issues with it, we'll just let docker report the problem.
    const fullTag = pieces.join("-");
    return fullTag ? `${repositoryUrl}:${fullTag}` : repositoryUrl;
}

async function pullCacheAsync(
    imageName: string,
    cacheFrom: pulumi.Unwrap<CacheFrom>,
    repoUrl: string,
    logResource: pulumi.Resource): Promise<string[] | undefined> {

    // Ensure that we have a repository URL. If we don't, we won't be able to pull anything.
    if (!repoUrl) {
        return undefined;
    }

    pulumi.log.debug(`pulling cache for ${imageName} from ${repoUrl}`, logResource);

    const cacheFromImages: string[] = [];
    const stages = (cacheFrom.stages || []).concat([""]);
    for (const stage of stages) {
        const tag = stage ? `:${stage}` : "";
        const image = `${repoUrl}${tag}`;

        // Try to pull the existing image if it exists.  This may fail if the image does not exist.
        // That's fine, just move onto the next stage.  Also, pass along a flag saying that we
        // should print that error as a warning instead.  We don't want the update to succeed but
        // the user to then get a nasty "error:" message at the end.
        const {code} = await runCommandThatCanFail(
            "docker", ["pull", image], logResource,
            /*reportFullCommand:*/ true, /*reportErrorAsWarning:*/ true);
        if (code) {
            continue;
        }

        cacheFromImages.push(image);
    }

    return cacheFromImages;
}

interface BuildResult {
    imageId: string;
    stages: string[];
}

async function buildImageAsync(
    imageName: string,
    pathOrBuild: string | pulumi.Unwrap<DockerBuild>,
    logResource: pulumi.Resource,
    cacheFrom: Promise<string[] | undefined>): Promise<BuildResult> {

    let build: pulumi.Unwrap<DockerBuild>;
    if (typeof pathOrBuild === "string") {
        build = {
            context: pathOrBuild,
        };
    } else if (pathOrBuild) {
        build = pathOrBuild;
    } else {
        throw new ResourceError(`Cannot build a container with an empty build specification`, logResource);
    }

    // If the build context is missing, default it to the working directory.
    if (!build.context) {
        build.context = ".";
    }

    logEphemeral(
        `Building container image '${imageName}': context=${build.context}` +
        (build.dockerfile ? `, dockerfile=${build.dockerfile}` : "") +
        (build.args ? `, args=${JSON.stringify(build.args)}` : ""), logResource);

    // If the container build specified build stages to cache, build each in turn.
    const stages = [];
    if (build.cacheFrom && typeof build.cacheFrom !== "boolean" && build.cacheFrom.stages) {
        for (const stage of build.cacheFrom.stages) {
            await dockerBuild(
                localStageImageName(imageName, stage), build, cacheFrom, logResource, stage);
            stages.push(stage);
        }
    }

    // Invoke Docker CLI commands to build.
    await dockerBuild(imageName, build, cacheFrom, logResource);

    // Finally, inspect the image so we can return the SHA digest. Do not forward the output of this
    // command this to the CLI to show the user.
    const inspectResult = await runCommandThatMustSucceed(
        "docker", ["image", "inspect", "-f", "{{.Id}}", imageName], logResource);
    if (!inspectResult) {
        throw new ResourceError(
            `No digest available for image ${imageName}`, logResource);
    }

    // From https://docs.docker.com/registry/spec/api/#content-digests
    //
    // the image id will be a "algorithm:hex" pair.  We don't care about the algorithm part.  All we
    // want is the unique portion we can use elsewhere.  Since we are also going to place this in an
    // image tag, we also don't want the colon, as that's not legal there.  So simply grab the hex
    // portion after the colon and return that.

    let imageId = inspectResult.trim();
    const colonIndex = imageId.lastIndexOf(":");
    imageId = colonIndex < 0 ? imageId : imageId.substr(colonIndex + 1);

    return {imageId, stages};
}

async function dockerBuild(
    imageName: string,
    build: pulumi.Unwrap<DockerBuild>,
    cacheFrom: Promise<string[] | undefined>,
    logResource: pulumi.Resource,
    target?: string): Promise<void> {

    // Prepare the build arguments.
    const buildArgs: string[] = ["build"];
    if (build.dockerfile) {
        buildArgs.push(...["-f", build.dockerfile]); // add a custom Dockerfile location.
    }
    if (build.args) {
        for (const arg of Object.keys(build.args)) {
            buildArgs.push(...["--build-arg", `${arg}=${build.args[arg]}`]);
        }
    }
    if (build.cacheFrom) {
        const cacheFromImages = await cacheFrom;
        if (cacheFromImages && cacheFromImages.length) {
            buildArgs.push(...["--cache-from", cacheFromImages.join()]);
        }
    }
    if (build.extraOptions) {
        buildArgs.push(...build.extraOptions);
    }
    buildArgs.push(build.context!); // push the docker build context onto the path.

    buildArgs.push(...["-t", imageName]); // tag the image with the chosen name.
    if (target) {
        buildArgs.push(...["--target", target]);
    }

    await runCommandThatMustSucceed("docker", buildArgs, logResource, undefined, undefined, build.env);

}

interface LoginResult {
    registryName: string;
    username: string;
    loginCommand: Promise<void>;
}

// Keep track of registries and users that have been logged in.  If we've already logged into that
// registry with that user, there's no need to do it again.
const loginResults: LoginResult[] = [];

function loginToRegistry(registry: pulumi.Unwrap<Registry>, logResource: pulumi.Resource): Promise<void> {
    const {registry: registryName, username, password} = registry;

    // See if we've issued an outstanding requests to login into this registry.  If so, just
    // await the results of that login request.  Otherwise, create a new request and keep it
    // around so that future login requests will see it.
    let loginResult = loginResults.find(
        r => r.registryName === registryName && r.username === username);
    if (!loginResult) {
        // Note: we explicitly do not 'await' the 'loginAsync' call here.  We do not want
        // to relinquish control of this thread-of-execution yet.  We want to ensure that
        // we first update `loginResults` with our record object so that any future executions
        // through this method see that the login was kicked off and can wait on that.
        loginResult = {registryName, username, loginCommand: loginAsync()};
        loginResults.push(loginResult);
    } else {
        logEphemeral(`Reusing existing login for ${username}@${registryName}`, logResource);
    }

    return loginResult.loginCommand;

    async function loginAsync() {
        const dockerPasswordStdin = await useDockerPasswordStdin(logResource);

        // pass 'reportFullCommandLine: false' here so that if we fail to login we don't emit the
        // username/password in our logs.  Instead, we'll just say "'docker login' failed with code ..."
        if (dockerPasswordStdin) {
            await runCommandThatMustSucceed(
                "docker", ["login", "-u", username, "--password-stdin", registryName],
                logResource, /*reportFullCommandLine*/ false, password);
        } else {
            await runCommandThatMustSucceed(
                "docker", ["login", "-u", username, "-p", password, registryName],
                logResource, /*reportFullCommandLine*/ false);
        }
    }
}

async function tagAndPushImageAsync(
    imageName: string, repositoryUrl: string,
    tag: string | undefined, imageId: string | undefined,
    logResource: pulumi.Resource): Promise<void> {

    // Ensure we have a unique target name for this image, and tag and push to that unique target.
    await doTagAndPushAsync(createTaggedImageName(repositoryUrl, tag, imageId));

    // If the user provided a tag themselves (like "x/y:dev") then also tag and push directly to
    // that 'dev' tag.  This is not going to be a unique location, and future pushes will overwrite
    // this location.  However, that's ok as there's still the unique target we generated above.
    //
    // Note: don't need to do this if imageId was 'undefined' as the above line will have already
    // taken care of things for us.
    if (tag !== undefined && imageId !== undefined) {
        await doTagAndPushAsync(createTaggedImageName(repositoryUrl, tag, /*imageId:*/ undefined));
    }

    return;

    async function doTagAndPushAsync(targetName: string) {
        await runCommandThatMustSucceed("docker", ["tag", imageName, targetName], logResource);
        await runCommandThatMustSucceed("docker", ["push", targetName], logResource);
    }
}

interface CommandResult {
    code: number;
    stdout: string;
}

function getCommandLineMessage(
    cmd: string, args: string[], reportFullCommandLine: boolean, env?: Record<string, string>) {

    const argString = reportFullCommandLine ? args.join(" ") : args[0];
    const envString = env === undefined ? "" : Object.keys(env).map(k => `${k}=${env[k]}`).join(" ");
    return `'${envString} ${cmd} ${argString}'`;
}

function getFailureMessage(
    cmd: string, args: string[], reportFullCommandLine: boolean, code: number, env?: Record<string, string>) {

    return `${getCommandLineMessage(cmd, args, reportFullCommandLine, env)} failed with exit code ${code}`;
}

// [reportFullCommandLine] is used to determine if the full command line should be reported
// when an error happens.  In general reporting the full command line is fine.  But it should be set
// to false if it might contain sensitive information (like a username/password)
async function runCommandThatMustSucceed(
    cmd: string,
    args: string[],
    logResource: pulumi.Resource,
    reportFullCommandLine: boolean = true,
    stdin?: string,
    env?: { [name: string]: string }): Promise<string> {

    const {code, stdout} = await runCommandThatCanFail(
        cmd, args, logResource, reportFullCommandLine, /*reportErrorAsWarning:*/ false, stdin, env);

    if (code !== 0) {
        // Fail the entire build and push.  This includes the full output of the command so that at
        // the end the user can review the full docker message about what the problem was.
        //
        // Note: a message about the command failing will have already been ephemerally reported to
        // the status column.
        throw new ResourceError(
            `${getFailureMessage(cmd, args, reportFullCommandLine, code)}\n${stdout}`, logResource);
    }

    return stdout;
}

// Runs a CLI command in a child process, returning a promise for the process's exit. Both stdout
// and stderr are redirected to process.stdout and process.stder by default.
//
// If the [stdin] argument is defined, it's contents are piped into stdin for the child process.
//
// [logResource] is used to specify the resource to associate command output with. Stderr messages
// are always sent (since they may contain important information about something that's gone wrong).
// Stdout messages will be logged ephemerally to this resource.  This lets the user know there is
// progress, without having that dumped on them at the end.  If an error occurs though, the stdout
// content will be printed.
//
// The promise returned by this function should never reach the rejected state.  Even if the
// underlying spawned command has a problem, this will result in a resolved promise with the
// [CommandResult.code] value set to a non-zero value.
async function runCommandThatCanFail(
    cmd: string,
    args: string[],
    logResource: pulumi.Resource,
    reportFullCommandLine: boolean,
    reportErrorAsWarning: boolean,
    stdin?: string,
    env?: { [name: string]: string }): Promise<CommandResult> {

    // Let the user ephemerally know the command we're going to execute.
    logEphemeral(`Executing ${getCommandLineMessage(cmd, args, reportFullCommandLine, env)}`, logResource);

    // Generate a unique stream-ID that we'll associate all the docker output with. This will allow
    // each spawned CLI command's output to associated with 'resource' and also streamed to the UI
    // in pieces so that it can be displayed live.  The stream-ID is so that the UI knows these
    // messages are all related and should be considered as one large message (just one that was
    // sent over in chunks).
    //
    // We use Math.random here in case our package is loaded multiple times in memory (i.e. because
    // different downstream dependencies depend on different versions of us).  By being random we
    // effectively make it completely unlikely that any two cli outputs could map to the same stream
    // id.
    //
    // Pick a reasonably distributed number between 0 and 2^30.  This will fit as an int32
    // which the grpc layer needs.
    const streamID = Math.floor(Math.random() * (1 << 30));

    return new Promise<CommandResult>((resolve, reject) => {
        const p = child_process.spawn(cmd, args, {env});

        // We store the results from stdout in memory and will return them as a string.
        let stdOutChunks: Buffer[] = [];
        let stdErrChunks: Buffer[] = [];

        p.stdout.on("data", (chunk: Buffer) => {
            // Report all stdout messages as ephemeral messages.  That way they show up in the
            // info bar as they're happening.  But they do not overwhelm the user as the end
            // of the run.
            logEphemeral(chunk.toString(), logResource);
            stdOutChunks.push(chunk);
        });

        p.stderr.on("data", (chunk: Buffer) => {
            // We can't stream these stderr messages as we receive them because we don't knows at
            // this point because Docker uses stderr for both errors and warnings.  So, instead, we
            // just collect the messages, and wait for the process to end to decide how to report
            // them.
            stdErrChunks.push(chunk);
        });

        // In both cases of 'error' or 'close' we execute the same 'finish up' codepath. This
        // codepath effectively flushes (and clears) the stdout and stderr streams we've been
        // buffering.  We'll also return the stdout stream to the caller, and we'll appropriately
        // return if we failed or not depending on if we got an actual exception, or if the spawned
        // process returned a non-0 error code.
        //
        // Effectively, we are ensuring that we never reject the promise we're returning.  It will
        // always 'resolve', and we will always have the behaviors that:
        //
        // 1. all stderr information is flushed (including the message of an exception if we got one).
        // 2. an ephemeral info message is printed stating if there were any exceptions/status-codes
        // 3. all stdout information is returned to the caller.
        // 4. the caller gets a 0-code on success, and a non-0-code for either an exception or an
        //    error status code.
        //
        // The caller can then decide what to do with this.  Nearly all callers will will be coming
        // through runCommandThatMustSucceed, which will see a non-0 code and will then throw with
        // a full message.

        p.on("error", err => {
            // received some sort of real error.  push the message of that error to our stdErr
            // stream (so it will get reported) and then move this promise to the resolved, 1-code
            // state to indicate failure.
            stdErrChunks.push(new Buffer(err.message));
            finish(/*code: */ 1);
        });

        p.on("close", code => {
            finish(code);
        });

        if (stdin) {
            p.stdin.end(stdin);
        }

        return;

        // Moves our promise to the resolved state, after appropriately dealing with any errors
        // we've encountered.  Importantly, this function can be called multiple times safely.
        // It will clean up after itself so that multiple calls don't end up causing any issues.

        function finish(code: number) {
            // Collapse our stored stdout/stderr messages into single strings.
            const stderr = Buffer.concat(stdErrChunks).toString();
            const stdout = Buffer.concat(stdOutChunks).toString();

            // Clear out our output buffers.  This ensures that if we get called again, we don't
            // double print these messages.
            stdOutChunks = [];
            stdErrChunks = [];

            // If we got any stderr messages, report them as an error/warning depending on the
            // result of the operation.
            if (stderr.length > 0) {
                if (code && !reportErrorAsWarning) {
                    // Command returned non-zero code.  Treat these stderr messages as an error.
                    pulumi.log.error(stderr, logResource, streamID);
                } else {
                    // command succeeded.  These were just warning.
                    pulumi.log.warn(stderr, logResource, streamID);
                }
            }

            // If the command failed report an ephemeral message indicating which command it was.
            // That way the user can immediately see something went wrong in the info bar.  The
            // caller (normally runCommandThatMustSucceed) can choose to also report this
            // non-ephemerally.
            if (code) {
                logEphemeral(getFailureMessage(cmd, args, reportFullCommandLine, code), logResource);
            }

            resolve({code, stdout});
        }
    });
}
