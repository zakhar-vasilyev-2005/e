import { MetricKind, ScalarKind } from "usearch";
import { main } from "./index.js";





try {
    await main({
        stdoutType: "inherit",
        embeddingModel: undefined,
        embedderParams: {
            port: 39512,
            timeout: 500,
            fallbackStartServer: {
                modelFile: "/mnt/120gb/Users/Public/LLMs/nomic-embed-text-v1.5.Q8_0.gguf",
                modelArgs: ["-mg", "0", "-ngl", "999", "-sm", "none"],
                timeout: 50_000,
            }
        },
        modelParams: {
            timeout: 500,
            fallbackStartServer: {
                modelFile: "/mnt/120gb/Users/Public/LLMs/Llama-3.2-1B-Instruct-IQ4_XS.gguf",
                modelParams: {
                    n_gpu_layers: 999,
                    main_gpu: 1,
                    check_tensors: false,
                    split_mode: "none",
                    use_extra_bufts: true,
                },
                timeout: 100_000,
            }
        },
        vectorIndexParams: {
            quantization: ScalarKind.F32,
            connectivity: 32,
            expansion_add: 256,
            expansion_search: 128,
            multi: false
        },
        memoryIndexSaveInterval: 10_000,
    });
} catch (e) {
    console.error(e);
}



//