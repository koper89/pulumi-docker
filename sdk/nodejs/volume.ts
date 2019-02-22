// *** WARNING: this file was generated by the Pulumi Terraform Bridge (tfgen) Tool. ***
// *** Do not edit by hand unless you're certain you know what you are doing! ***

import * as pulumi from "@pulumi/pulumi";
import * as utilities from "./utilities";

/**
 * Creates and destroys a volume in Docker. This can be used alongside
 * [docker\_container](https://www.terraform.io/docs/providers/docker/r/container.html)
 * to prepare volumes that can be shared across containers.
 * 
 * ## Example Usage
 * 
 * ```typescript
 * import * as pulumi from "@pulumi/pulumi";
 * import * as docker from "@pulumi/docker";
 * 
 * // Creates a docker volume "shared_volume".
 * const sharedVolume = new docker.Volume("shared_volume", {});
 * ```
 */
export class Volume extends pulumi.CustomResource {
    /**
     * Get an existing Volume resource's state with the given name, ID, and optional extra
     * properties used to qualify the lookup.
     *
     * @param name The _unique_ name of the resulting resource.
     * @param id The _unique_ provider ID of the resource to lookup.
     * @param state Any extra arguments used during the lookup.
     */
    public static get(name: string, id: pulumi.Input<pulumi.ID>, state?: pulumi.WrappedObject<VolumeState>, opts?: pulumi.CustomResourceOptions): Volume {
        return new Volume(name, <any>state, { ...opts, id: id });
    }

    /**
     * Driver type for the volume (defaults to local).
     */
    public readonly driver: pulumi.Output<string>;
    /**
     * Options specific to the driver.
     */
    public readonly driverOpts: pulumi.Output<{[key: string]: any} | undefined>;
    /**
     * User-defined key/value metadata.
     */
    public readonly labels: pulumi.Output<{[key: string]: any} | undefined>;
    public /*out*/ readonly mountpoint: pulumi.Output<string>;
    /**
     * The name of the Docker volume (generated if not
     * provided).
     */
    public readonly name: pulumi.Output<string>;

    /**
     * Create a Volume resource with the given unique name, arguments, and options.
     *
     * @param name The _unique_ name of the resource.
     * @param args The arguments to use to populate this resource's properties.
     * @param opts A bag of options that control this resource's behavior.
     */
    constructor(name: string, args?: pulumi.WrappedObject<VolumeArgs>, opts?: pulumi.CustomResourceOptions)
    constructor(name: string, argsOrState?: pulumi.WrappedObject<VolumeArgs> | pulumi.WrappedObject<VolumeState>, opts?: pulumi.CustomResourceOptions) {
        let inputs: pulumi.Inputs = {};
        if (opts && opts.id) {
            const state: VolumeState = argsOrState as VolumeState | undefined;
            inputs["driver"] = state ? state.driver : undefined;
            inputs["driverOpts"] = state ? state.driverOpts : undefined;
            inputs["labels"] = state ? state.labels : undefined;
            inputs["mountpoint"] = state ? state.mountpoint : undefined;
            inputs["name"] = state ? state.name : undefined;
        } else {
            const args = argsOrState as VolumeArgs | undefined;
            inputs["driver"] = args ? args.driver : undefined;
            inputs["driverOpts"] = args ? args.driverOpts : undefined;
            inputs["labels"] = args ? args.labels : undefined;
            inputs["name"] = args ? args.name : undefined;
            inputs["mountpoint"] = undefined /*out*/;
        }
        super("docker:index/volume:Volume", name, inputs, opts);
    }
}

/**
 * Input properties used for looking up and filtering Volume resources.
 */
export interface VolumeState {
    /**
     * Driver type for the volume (defaults to local).
     */
    readonly driver?: string;
    /**
     * Options specific to the driver.
     */
    readonly driverOpts?: {[key: string]: any};
    /**
     * User-defined key/value metadata.
     */
    readonly labels?: {[key: string]: any};
    readonly mountpoint?: string;
    /**
     * The name of the Docker volume (generated if not
     * provided).
     */
    readonly name?: string;
}

/**
 * The set of arguments for constructing a Volume resource.
 */
export interface VolumeArgs {
    /**
     * Driver type for the volume (defaults to local).
     */
    readonly driver?: string;
    /**
     * Options specific to the driver.
     */
    readonly driverOpts?: {[key: string]: any};
    /**
     * User-defined key/value metadata.
     */
    readonly labels?: {[key: string]: any};
    /**
     * The name of the Docker volume (generated if not
     * provided).
     */
    readonly name?: string;
}
